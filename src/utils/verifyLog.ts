import type { Guild, GuildMember } from "discord.js";
import { logger } from "./logger.js";
import { VERIFY_LOG_CHANNEL_ID } from "./verify.js";

/**
 * Schreibt ein Verify-Ereignis in den Log-Kanal. Die Meldungen werden an den
 * Kanal angehängt statt ersetzt - so bleibt der ganze Ablauf einsehbar.
 *
 * Läuft bewusst im Hintergrund: Fehlt der Kanal oder geht die Meldung nicht
 * raus, darf der Verify-Ablauf davon nicht aufhalten oder stürzen.
 */

/* Menschlich lesbare Dauer: "42 sek" oder "1:30 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")} min` : `${r} sek`;
}

interface VerifyLogEvent {
  /** Überschrift, z. B. "Verifiziert" oder "Fehlgeschlagen". */
  title: string;
  /** Mitglied, um das es geht. */
  member: GuildMember;
  /** Detailzeilen unter der Überschrift. */
  lines?: string[];
}

export async function logVerifyEvent(
  guild: Guild,
  event: VerifyLogEvent,
): Promise<void> {
  const channel =
    guild.channels.cache.get(VERIFY_LOG_CHANNEL_ID) ??
    (await guild.channels.fetch(VERIFY_LOG_CHANNEL_ID).catch(() => null));

  if (!channel?.isTextBased()) return;

  const content = [
    `**${event.title}**`,
    `<@${event.member.id}>`,
    ...(event.lines ?? []),
  ].join("\n");

  try {
    await channel
      .send({ content, allowedMentions: { parse: [] } })
      .catch((err) => {
        logger.warn("Verify-Logeintrag konnte nicht gesendet werden.", {
          guildId: guild.id,
          error: err,
        });
      });
  } catch (err) {
    logger.warn("Verify-Log-Kanal nicht erreichbar.", {
      guildId: guild.id,
      error: err,
    });
  }
}