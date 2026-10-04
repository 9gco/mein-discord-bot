import {
  Events,
  type Client,
  type Guild,
  type GuildMember,
  type VoiceState,
} from "discord.js";
import { logger } from "../utils/logger.js";
import {
  applyQueueNickname,
  connectToVerifyChannel,
  dequeueWaiting,
  enqueueWaiting,
  fetchTtsAudio,
  getVerifyConfig,
  peekNextWaiting,
  playBuffer,
  renumberWaiting,
  runExclusive,
  runMicCheck,
  spokenName,
  stripQueueNickname,
  waitForSilence,
  WAITING_CHANNEL_ID,
  type VerifyConfig,
} from "../utils/verify.js";
import type { BotEvent } from "./index.js";

/** Mitglieder, die gerade geprüft werden – verhindert Doppel-Starts. */
const busy = new Set<string>();
/** Pro Guild: läuft bereits eine Prüfung? */
const activeGuild = new Map<string, string>();

function busyKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/**
 * Vergibt die Prüf-Rollen. `micRoleId` gibt dem Mitglied nur während der
 * Prüfung Sprechberechtigung und wird danach wieder genommen; die dauerhaften
 * Rollen aus `cfg.roles` bleiben unangetastet.
 */
async function grantMicRole(member: GuildMember, micRoleId: string): Promise<boolean> {
  if (member.roles.cache.has(micRoleId)) return true;
  try {
    await member.roles.add(micRoleId, "Mikrofon-Check: Sprechberechtigung");
    return true;
  } catch (err) {
    logger.error("Prüf-Rolle konnte nicht vergeben werden.", {
      guildId: member.guild.id,
      userId: member.id,
      roleId: micRoleId,
      error: err,
    });
    return false;
  }
}

async function revokeMicRole(member: GuildMember, micRoleId: string): Promise<void> {
  if (!member.roles.cache.has(micRoleId)) return;
  try {
    await member.roles.remove(micRoleId, "Mikrofon-Check beendet");
  } catch (err) {
    logger.error("Prüf-Rolle konnte nicht entfernt werden.", {
      guildId: member.guild.id,
      userId: member.id,
      roleId: micRoleId,
      error: err,
    });
  }
}

/** Spielt eine Ansage, nachdem im Kanal Ruhe herrscht. */
async function speak(
  guild: Guild,
  channelId: string,
  text: string,
  voice: string,
): Promise<void> {
  const connection = await connectToVerifyChannel(guild, channelId);
  if (!connection) {
    logger.error("Keine Voice-Verbindung – Ansage entfällt.", {
      guildId: guild.id,
      channelId,
    });
    return;
  }
  // Erst warten, bis niemand spricht, sonst redet der Bot mitten im Satz rein.
  await waitForSilence(connection);
  const buffer = await fetchTtsAudio(text, voice);
  await playBuffer(connection, buffer);
}

/**
 * Gibt den Warteschlangen-Slot wieder frei und rückt die Nummern nach.
 * Nötig, wenn ein Durchlauf früh abbricht – sonst bleibt der Slot vorne
 * stehen und der nächste Start versucht immer denselben Kandidaten.
 */
async function releaseQueueSlot(guild: Guild, member: GuildMember): Promise<void> {
  dequeueWaiting(guild.id, member.id);
  await stripQueueNickname(guild, member.id);
  await renumberWaiting(guild);
}

/**
 * Vollständiger Prüf-Durchlauf für ein Mitglied:
 * in den Prüf-Kanal ziehen → Ansage → Mikrofon-Check → Ergebnis melden →
 * Rechte zurücksetzen → aus dem Call entfernen.
 */
async function runVerify(
  guild: Guild,
  member: GuildMember,
  cfg: VerifyConfig,
): Promise<void> {
  const verifyChannelId = cfg.channelId;
  const micRoleId = cfg.micRoleId;
  if (!verifyChannelId) {
    await releaseQueueSlot(guild, member);
    return;
  }

  // 1) Aus dem Warteraum in den Prüf-Kanal holen.
  if (member.voice.channelId !== verifyChannelId) {
    try {
      await member.voice.setChannel(verifyChannelId);
    } catch (err) {
      logger.error("Mitglied konnte nicht in den Prüf-Kanal bewegt werden.", {
        guildId: guild.id,
        userId: member.id,
        channelId: verifyChannelId,
        error: err,
      });
      await releaseQueueSlot(guild, member);
      return;
    }
  }

  // 2) Im Prüf-Kanal zählt der echte Name, die "(n) "-Nummer fällt weg und
  //    wird auch nicht vorgelesen.
  await stripQueueNickname(guild, member.id);

  const connection = await connectToVerifyChannel(guild, verifyChannelId);
  if (!connection) {
    logger.error("Konnte dem Prüf-Kanal nicht beitreten.", {
      guildId: guild.id,
      channelId: verifyChannelId,
    });
    await releaseQueueSlot(guild, member);
    return;
  }

  const name = spokenName(member.displayName);

  try {
    // 3) Begrüßung mit der Check-Aufforderung.
    await speak(guild, verifyChannelId, cfg.message.replace(/\{user\}/g, name), cfg.voice);

    // 4) Sprechberechtigung für die Prüfung geben.
    const maySpeak = await grantMicRole(member, micRoleId);
    if (!maySpeak) {
      logger.warn("Ohne Prüf-Rolle kein Mikrofon-Check möglich.", {
        guildId: guild.id,
        userId: member.id,
      });
      return;
    }

    // 5) Warten, bis der Nutzer bereit ist, dann aufnehmen.
    await waitForSilence(connection);
    const result = await runMicCheck(connection, member.id);

    if (result.ok) {
      // 6a) Erfolg: Ergebnis melden und die dauerhaften Rollen geben.
      await speak(
        guild,
        verifyChannelId,
        cfg.micPassedMessage.replace(/\{user\}/g, name),
        cfg.voice,
      );

      const rolesToAdd = cfg.roles.filter((roleId) => !member.roles.cache.has(roleId));
      if (rolesToAdd.length > 0) {
        try {
          await member.roles.add(rolesToAdd, "Automatische Verifizierung");
        } catch (err) {
          logger.error("Verify-Rollen konnten nicht vergeben werden.", {
            guildId: guild.id,
            userId: member.id,
            roleIds: rolesToAdd,
            error: err,
          });
        }
      }
    } else {
      // 6b) Mikrofon unbrauchbar: sagen, woran es liegt, und nichts freischalten.
      const reason =
        result.reason === "too_quiet"
          ? "Dein Mikrofon ist zu leise – ich habe zwar etwas gehört, es ist aber kaum verständlich."
          : "Ich habe aus deinem Mikrofon keinen Ton bekommen.";
      logger.info("Mikrofon-Check fehlgeschlagen.", {
        guildId: guild.id,
        userId: member.id,
        reason: result.reason,
        speechMs: result.speechMs,
        level: result.level,
      });
      await speak(
        guild,
        verifyChannelId,
        `${reason} ${cfg.micFailedMessage.replace(/\{user\}/g, name)}`,
        cfg.voice,
      );
    }
  } catch (err) {
    logger.error("Prüf-Durchlauf fehlgeschlagen.", {
      guildId: guild.id,
      userId: member.id,
      error: err,
    });
  } finally {
    // 7) Nur die Prüf-Rolle zurücknehmen, alle anderen Rollen bleiben.
    await revokeMicRole(member, micRoleId);
    dequeueWaiting(guild.id, member.id);
    // Die Nummern der Wartenden rücken nach.
    await renumberWaiting(guild);
    // 8) Aus dem Call entfernen.
    if (member.voice.channelId) {
      await member.voice.setChannel(null).catch(() => undefined);
    }
  }
}

/** Startet die Prüfung des nächsten Wartenden, falls noch keiner läuft. */
function startNextIfIdle(guild: Guild, cfg: VerifyConfig): void {
  if (activeGuild.has(guild.id)) return;
  const next = peekNextWaiting(guild.id);
  if (!next) return;

  const member = guild.members.cache.get(next.userId);
  if (!member) {
    // Mitglied hat den Server verlassen – Eintrag verwerfen und weiter.
    dequeueWaiting(guild.id, next.userId);
    startNextIfIdle(guild, cfg);
    return;
  }

  const key = busyKey(guild.id, next.userId);
  if (busy.has(key)) return;

  busy.add(key);
  activeGuild.set(guild.id, next.userId);

  void runExclusive(guild.id, async () => {
    try {
      await runVerify(guild, member, cfg);
    } finally {
      busy.delete(key);
      if (activeGuild.get(guild.id) === next.userId) activeGuild.delete(guild.id);
      startNextIfIdle(guild, cfg);
    }
  });
}

/**
 * Nach einem Neustart: alle, die noch im Warteraum hängen, wieder einreihen und
 * die Prüfung starten. Ohne das würde nach einem Deploy niemand mehr aufgerufen,
 * weil VoiceStateUpdate nur bei Kanalwechseln feuert.
 *
 * Die ursprüngliche Beitrittsreihenfolge lässt sich nach einem Neustart nicht
 * wiederherstellen – discord.js liefert keinen Zeitstempel dafür. Wir nehmen
 * daher die Reihenfolge, in der die Voice-States im Cache liegen.
 */
export async function resumeVerifyQueue(client: Client<true>): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const cfg = await getVerifyConfig(guild.id);
      if (!cfg.enabled || !cfg.channelId) continue;

      const waitingChannelId = cfg.waitingChannelId || WAITING_CHANNEL_ID;
      const channel = guild.channels.cache.get(waitingChannelId);
      if (!channel?.isVoiceBased()) continue;

      const userIds = [...guild.voiceStates.cache.values()]
        .filter((state) => state.channelId === waitingChannelId)
        .map((state) => state.id);

      if (userIds.length === 0) {
        startNextIfIdle(guild, cfg);
        continue;
      }

      const waiting = (
        await guild.members.fetch({ user: userIds })
      ).values();

      let count = 0;
      for (const member of waiting) {
        if (member.user.bot) continue;
        if (member.voice.channelId !== waitingChannelId) continue;
        if (cfg.roles.some((roleId) => member.roles.cache.has(roleId))) continue;
        const position = enqueueWaiting(
          guild.id,
          member.id,
          member.nickname,
          member.displayName,
        );
        await applyQueueNickname(guild, member.id, position);
        count++;
      }

      if (count > 0) {
        logger.info("Warteschlange nach Neustart wiederhergestellt.", {
          guildId: guild.id,
          count,
        });
      }
      startNextIfIdle(guild, cfg);
    } catch (err) {
      logger.error("Warteschlange konnte nicht wiederhergestellt werden.", {
        guildId: guild.id,
        error: err,
      });
    }
  }
}

const event: BotEvent<Events.VoiceStateUpdate> = {
  name: Events.VoiceStateUpdate,

  async execute(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guild = newState.guild;
    if (!guild) return;

    // Nur echte Mitglieder, keine Bots.
    if (newState.member?.user.bot) return;

    // Nur Beitritte interessieren uns, keine Mute-/Unmute-Ereignisse.
    if (!newState.channelId) return;
    if (oldState.channelId === newState.channelId) return;

    const cfg = await getVerifyConfig(guild.id);
    if (!cfg.enabled) return;

    const member = newState.member;
    if (!member) return;

    const waitingChannelId = cfg.waitingChannelId || WAITING_CHANNEL_ID;
    const verifyChannelId = cfg.channelId;
    if (!verifyChannelId) return;

    // Bereits verifiziert → ignorieren.
    if (cfg.roles.some((roleId) => member.roles.cache.has(roleId))) return;

    const key = busyKey(guild.id, member.id);

    // 1) Beitritt in den Warteraum: Platz in der Schlange sichern, Namen
    //    mit der Wartenummer versehen und – falls nichts wartet – starten.
    if (newState.channelId === waitingChannelId && oldState.channelId !== verifyChannelId) {
      if (busy.has(key)) return;
      const position = enqueueWaiting(
        guild.id,
        member.id,
        member.nickname,
        member.displayName,
      );
      await applyQueueNickname(guild, member.id, position);
      logger.info("Mitglied in der Warteschlange.", {
        guildId: guild.id,
        userId: member.id,
        position,
      });
      startNextIfIdle(guild, cfg);
      return;
    }

    // 2) Direkter Beitritt in den Prüf-Kanal: ebenfalls einreihen und prüfen.
    if (newState.channelId === verifyChannelId) {
      if (busy.has(key)) return;
      const position = enqueueWaiting(
        guild.id,
        member.id,
        member.nickname,
        member.displayName,
      );
      await applyQueueNickname(guild, member.id, position);
      startNextIfIdle(guild, cfg);
      return;
    }

    // 3) Aus dem Prüf-Kanal wieder in den Warteraum: neu einreihen.
    if (oldState.channelId === verifyChannelId && newState.channelId !== verifyChannelId) {
      dequeueWaiting(guild.id, member.id);
      if (newState.channelId === waitingChannelId) {
        const position = enqueueWaiting(
          guild.id,
          member.id,
          member.nickname,
          member.displayName,
        );
        await applyQueueNickname(guild, member.id, position);
      } else {
        await renumberWaiting(guild);
      }
    }
  },
};

export default event;