import { Events, type Guild, type GuildMember, type VoiceState } from "discord.js";
import { logger } from "../utils/logger.js";
import {
  connectToVerifyChannel,
  fetchTtsAudio,
  getVerifyConfig,
  playBuffer,
  runExclusive,
  type VerifyConfig,
} from "../utils/verify.js";
import type { BotEvent } from "./index.js";

/** Nutzer, die gerade in der Warteschlange stehen oder verarbeitet werden. */
const pending = new Set<string>();

/**
 * Führt die eigentliche Verifizierung aus: Ansage abspielen, Rollen vergeben,
 * aus dem Call werfen. Rollen werden immer vergeben, auch wenn die Ansage
 * fehlschlägt.
 */
async function verifyMember(
  guild: Guild,
  member: GuildMember,
  cfg: VerifyConfig,
): Promise<void> {
  const channelId = cfg.channelId;
  if (!channelId) return;

  // Wer den Kanal inzwischen verlassen hat, wird nicht verifiziert.
  if (member.voice.channelId !== channelId) {
    logger.info("Nutzer hat den Verify-Kanal verlassen – überspringe.", {
      guildId: guild.id,
      userId: member.id,
    });
    return;
  }

  const connection = await connectToVerifyChannel(guild, channelId);
  if (!connection) {
    logger.error("Konnte keine Voice-Verbindung zum Verify-Kanal herstellen.", {
      guildId: guild.id,
      channelId,
    });
  } else {
    // Ansage abspielen – darf die eigentliche Verifizierung nicht blockieren.
    try {
      const text = cfg.message.replace(/\{user\}/g, member.displayName);
      const buffer = await fetchTtsAudio(text, cfg.voice);
      await playBuffer(connection, buffer);
    } catch (err) {
      logger.error("TTS-Ansage konnte nicht abgespielt werden.", {
        guildId: guild.id,
        userId: member.id,
        error: err,
      });
    }
  }

  // Rollen vergeben (alle, die der Nutzer noch nicht hat) – immer, auch wenn
  // die Audio-Ausgabe fehlgeschlagen ist.
  const rolesToAdd = cfg.roles.filter((roleId) => !member.roles.cache.has(roleId));
  if (rolesToAdd.length > 0) {
    try {
      await member.roles.add(rolesToAdd, "Automatische TTS-Verifizierung");
    } catch (err) {
      logger.error("Verify-Rollen konnten nicht vergeben werden.", {
        guildId: guild.id,
        userId: member.id,
        roleIds: rolesToAdd,
        error: err,
      });
    }
  }

  // Nutzer nach der Ansage aus dem Call werfen.
  if (member.voice.channelId) {
    await member.voice.setChannel(null).catch(() => undefined);
  }
}

const event: BotEvent<Events.VoiceStateUpdate> = {
  name: Events.VoiceStateUpdate,

  async execute(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guild = newState.guild;
    if (!guild) return;

    // Nur echte Mitglieder, keine Bots.
    if (newState.member?.user.bot) return;

    // Nur Beitritte in den Zielkanal interessieren uns.
    if (!newState.channelId) return;

    // Nur echte Kanalwechsel (Beitritt) – nicht bei Mute/Deafen-Änderungen.
    if (oldState.channelId === newState.channelId) return;

    const cfg = await getVerifyConfig(guild.id);
    if (!cfg.enabled) return;
    if (!cfg.channelId) return;
    if (newState.channelId !== cfg.channelId) return;

    const member = newState.member;
    if (!member) return;

    // Bereits verifiziert → ignorieren.
    if (cfg.roles.some((roleId) => member.roles.cache.has(roleId))) return;

    // Nicht doppelt einreihen, falls dasselbe Event mehrfach eintrifft.
    if (pending.has(member.id)) return;
    pending.add(member.id);

    // Alle Verifizierungen laufen nacheinander, damit sich parallele Joins
    // nicht gegenseitig die Wiedergabe abschneiden.
    void runExclusive(guild.id, async () => {
      try {
        await verifyMember(guild, member, cfg);
      } finally {
        pending.delete(member.id);
      }
    });
  },
};

export default event;
