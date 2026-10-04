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
  clearCooldown,
  connectToVerifyChannel,
  cooldownRemaining,
  dequeueWaiting,
  enqueueWaiting,
  ensureMicRoleChannelPermissions,
  fetchTtsAudio,
  getVerifyConfig,
  peekFirstEligible,
  playBuffer,
  renumberWaiting,
  runExclusive,
  runMicCheck,
  setCooldown,
  spokenName,
  stripQueueNickname,
  waitForSilence,
  WAITING_CHANNEL_ID,
  type MicCheckResult,
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

/** Kurze Pause, damit der Nutzer nach der Ansage losreden kann. */
const MIC_START_DELAY_MS = 1_200;

/**
 * Wie viele Prüfversuche ein Mitglied im Prüf-Kanal bekommt, bevor es in die
 * Wartezeit muss. Die meisten Fehler sind Einstellungsprobleme, die sich
 * direkt korrigieren lassen – deshalb zwei zusätzliche Versuche.
 */
const MIC_MAX_ATTEMPTS = 3;

/**
 * Wartezeit nach dem letzten Fehlversuch. Das Mitglied bleibt dabei einfach in
 * der Warteschlange, wird aber übersprungen, während die Zeit läuft – so
 * blockiert es niemanden.
 */
const MIC_COOLDOWN_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Gibt dem Mitglied die Prüf-Rolle. Die Rolle bleibt danach dauerhaft
 * bestehen – abgesichert wird über die Kanalrechte, nicht über die Rolle.
 */
async function grantMicRole(member: GuildMember, micRoleId: string): Promise<boolean> {
  if (member.roles.cache.has(micRoleId)) return true;
  try {
    await member.roles.add(micRoleId, "Freischaltung für den Mikrofon-Check");
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
 * Übersetzt ein Messergebnis in einen Satz, den der Bot vorlesen kann. Der Text
 * nennt den konkreten Grund, damit das Mitglied weiß, was es ändern muss.
 */
function describeMicProblem(result: MicCheckResult): string {
  switch (result.reason) {
    case "no_speech":
      return "Ich habe aus deinem Mikrofon überhaupt keinen Ton bekommen.";
    case "too_short":
      return (
        `Ich habe nur ${Math.round(result.speechMs / 100) / 10} Sekunden ` +
        "Sprache bekommen – das ist zu wenig zum Beurteilen."
      );
    case "clipping":
      return (
        "Dein Mikrofon ist übersteuert, es knackt und verzerrt. " +
        "Drehe die Eingabelautstärke oder den Mikrofon-Gain etwas runder."
      );
    case "noisy":
      return (
        "Bei dir ist sehr viel Hintergrundrauschen, ich kann dich kaum " +
        "von anderen Geräuschen unterscheiden."
      );
    case "too_quiet":
      return (
        "Dein Mikrofon ist zu leise – ich habe zwar gehört, dass du da bist, " +
        "aber nicht, was du sagst."
      );
    case "error":
    default:
      return "Bei der Prüfung ist ein technischer Fehler aufgetreten.";
  }
}

/**
 * Vollständiger Prüf-Durchlauf für ein Mitglied:
 * Rolle geben und Sprechrecht freischalten → in den Prüf-Kanal ziehen → Ansage
 * → Mikrofon-Check (bis zu `MIC_MAX_ATTEMPTS` Versuche) → Ergebnis melden →
 * Sprechrecht sperren → Wartezeit bei Fehlschlag → aus dem Call entfernen.
 *
 * Die Prüf-Rolle bleibt dauerhaft am Mitglied. Das Sprechrecht wird von der
 * Rolle über die Kanalrechte gesteuert: an während der Prüfung, aus danach.
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

  // 1) Rolle und Kanalrechte zuerst: das Mitglied braucht Connect, bevor es
  //    in den Kanal bewegt wird. Das Sprechrecht bleibt hier noch aus – es
  //    wird erst freigeschaltet, wenn der Bot zum Sprechen auffordert.
  const maySpeak = await grantMicRole(member, micRoleId);
  if (!maySpeak) {
    logger.warn("Ohne Prüf-Rolle kein Mikrofon-Check möglich.", {
      guildId: guild.id,
      userId: member.id,
    });
    await releaseQueueSlot(guild, member);
    return;
  }
  const reachable = await ensureMicRoleChannelPermissions(
    guild,
    verifyChannelId,
    micRoleId,
    false,
  );
  if (!reachable) {
    logger.warn(
      "Ohne Connect im Prüf-Kanal kann das Mitglied nicht hineinbewegt werden.",
      { guildId: guild.id, userId: member.id },
    );
    await releaseQueueSlot(guild, member);
    return;
  }

  // 2) Aus dem Warteraum in den Prüf-Kanal holen.
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

  // 3) Im Prüf-Kanal zählt der echte Name, die "(n) "-Nummer fällt weg und
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
    // 4) Begrüßung mit der Check-Aufforderung.
    await speak(
      guild,
      verifyChannelId,
      cfg.message.replace(/\{user\}/g, name),
      cfg.voice,
    );

    // 5) Mehrere Versuche direkt nacheinander. Die meisten Fehler sind
    //    Einstellungsprobleme, die sich sofort korrigieren lassen.
    let passed = false;
    let lastResult: MicCheckResult | undefined;

    for (let attempt = 1; attempt <= MIC_MAX_ATTEMPTS; attempt++) {
      if (attempt > 1) {
        await speak(
          guild,
          verifyChannelId,
          `Kein Problem, wir versuchen es nochmal. Diesmal ist dein ` +
            `Versuch Nummer ${attempt} von ${MIC_MAX_ATTEMPTS}.`,
          cfg.voice,
        );
      }

      // Erst zum Sprechen auffordern, dann das Sprechrecht freischalten. Vorher
      // darf das Mitglied im Prüf-Kanal nur zuhören.
      await speak(
        guild,
        verifyChannelId,
        cfg.speakNowMessage.replace(/\{user\}/g, name),
        cfg.voice,
      );
      const armedForAttempt = await ensureMicRoleChannelPermissions(
        guild,
        verifyChannelId,
        micRoleId,
        true,
      );
      if (!armedForAttempt) {
        logger.warn("Sprechrecht konnte nicht freigeschaltet werden.", {
          guildId: guild.id,
          userId: member.id,
        });
        break;
      }

      // Kurz Luft lassen, damit der Nutzer direkt losreden kann. Hier bewusst
      // KEIN Warten auf Stille – sonst würde eine sofort begonnene Antwort
      // vergehen, weil wir erst auf ihr Ende warten würden. Der Mic-Check
      // wartet von sich aus bis zu MIC_MAX_WAIT_MS auf den ersten Ton.
      await delay(MIC_START_DELAY_MS);
      const result = await runMicCheck(connection, member.id);

      // Und direkt wieder stumm, bevor der Bot den Fehler erklärt.
      await ensureMicRoleChannelPermissions(
        guild,
        verifyChannelId,
        micRoleId,
        false,
      );

      lastResult = result;

      logger.info(`Mikrofon-Check Versuch ${attempt}/${MIC_MAX_ATTEMPTS}.`, {
        guildId: guild.id,
        userId: member.id,
        ok: result.ok,
        reason: result.reason,
        speechMs: result.speechMs,
        level: result.level,
        peak: result.peak,
        snr: result.snr,
      });

      if (result.ok) {
        passed = true;
        break;
      }

      // Grund nennen, aber erst nach dem letzten Versuch die Zusatzanweisung.
      const problem = describeMicProblem(result);
      const isLast = attempt === MIC_MAX_ATTEMPTS;
      await speak(
        guild,
        verifyChannelId,
        isLast
          ? `${problem} ${cfg.micFailedMessage.replace(/\{user\}/g, name)}`
          : problem,
        cfg.voice,
      );
    }

    if (passed) {
      // 6a) Erfolg: Ergebnis melden, dauerhafte Rollen geben, Wartezeit lösen.
      await speak(
        guild,
        verifyChannelId,
        cfg.micPassedMessage.replace(/\{user\}/g, name),
        cfg.voice,
      );

      const rolesToAdd = cfg.roles.filter(
        (roleId) => !member.roles.cache.has(roleId),
      );
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
      clearCooldown(guild.id, member.id);
    } else {
      // 6b) Alle Versuche durch: Wartezeit setzen, damit die Schlange
      //     weiterläuft. Wer in der Zwischenzeit wieder in den Warteraum
      //     kommt, wird solange übersprungen.
      const seconds = Math.ceil(MIC_COOLDOWN_MS / 1000);
      setCooldown(guild.id, member.id, MIC_COOLDOWN_MS);
      logger.info("Wartezeit nach Fehlschlag gesetzt.", {
        guildId: guild.id,
        userId: member.id,
        reason: lastResult?.reason,
        cooldownMs: MIC_COOLDOWN_MS,
      });
      // Wecker, damit die Schlange weiterläuft, sobald die Zeit abgelaufen
      // ist – VoiceStateUpdate feuert dafür nicht.
      const timer = setTimeout(
        () => {
          void getVerifyConfig(guild.id).then((latest) => {
            startNextIfIdle(guild, latest);
          });
        },
        MIC_COOLDOWN_MS + 500,
      );
      // Der Timer darf den Prozess nicht am Leben halten.
      timer.unref?.();
      await speak(
        guild,
        verifyChannelId,
        `Komm bitte in ${seconds} Sekunden noch einmal in den Warteraum, ` +
          `dann versuchen wir es erneut.`,
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
    // 7) Sprechrecht wieder sperren. Die Rolle selbst bleibt bestehen.
    await ensureMicRoleChannelPermissions(
      guild,
      verifyChannelId,
      micRoleId,
      false,
    );
    dequeueWaiting(guild.id, member.id);
    // Die Nummern der Wartenden rücken nach.
    await renumberWaiting(guild);
    // 8) Aus dem Call entfernen.
    if (member.voice.channelId) {
      await member.voice.setChannel(null).catch(() => undefined);
    }
  }
}

/**
 * Startet die Prüfung des nächsten Wartenden, falls noch keiner läuft. Wer noch
 * in der Wartezeit ist, wird übersprungen – so blockiert ein fehlgeschlagenes
 * Mikrofon nicht die ganze Schlange.
 */
function startNextIfIdle(guild: Guild, cfg: VerifyConfig): void {
  if (activeGuild.has(guild.id)) return;
  const next = peekFirstEligible(
    guild.id,
    (userId) => cooldownRemaining(guild.id, userId) === 0,
  );
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