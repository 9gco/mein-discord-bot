import {
  type ColorResolvable,
  EmbedBuilder,
  type Guild,
  type GuildMember,
} from "discord.js";
import { logger } from "./logger.js";
import { VERIFY_LOG_CHANNEL_ID } from "./verify.js";

/**
 * Verify-Log als ein Embed pro Person.
 *
 * Der ganze Vorgang eines Mitglieds wird erst gesammelt und am Ende als genau
 * EINE Nachricht in den Log-Kanal geschickt: Wer war es, wie lange hat
 * gewartet, welche Versuche gab es, was ist dabei herausgekommen.
 *
 * Läuft bewusst im Hintergrund: Fehlt der Kanal oder geht die Meldung nicht
 * raus, darf der Verify-Ablauf davon nicht aufhalten oder stürzen.
 */

/** Ein gesammelter Schritt des Ablaufs, z. B. das Einreihen in die Schlange. */
export interface VerifyLogEntry {
  title: string;
  lines: string[];
}

/* Menschlich lesbare Dauer: "42 sek" oder "1:30 min". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")} min` : `${r} sek`;
}

/** Farben je nach Ausgang des Vorgangs. */
export const LOG_COLORS = {
  ok: 0x2ecc71,
  fail: 0xe74c3c,
  off: 0x95a5a6,
} as const;

/** "guildId:userId" → gesammelte Log-Schritte des laufenden Vorgangs. */
const pending = new Map<string, { member: GuildMember; entries: VerifyLogEntry[] }>();

function pendingKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/**
 * Beginnt das Log für ein Mitglied, das sich gerade eingereiht hat. Erste
 * Zeilen werden mitgesammelt und erst am Ende zusammen ausgegeben.
 */
export function startVerifyLog(
  guildId: string,
  userId: string,
  member: GuildMember,
  entry: VerifyLogEntry,
): void {
  pending.set(pendingKey(guildId, userId), { member, entries: [entry] });
}

/**
 * Schickt das gesammelte Log als eine einzige Embed-Nachricht in den
 * Log-Kanal und räumt den Eintrag auf. Ein zweiter Aufruf für dieselbe Person
 * würde nichts mehr vorfinden – pro Vorgang erscheint genau ein Log.
 */
export async function finishVerifyLog(
  guild: Guild,
  member: GuildMember,
  result: { title: string; color: ColorResolvable; lines: string[] },
): Promise<void> {
  const acc = pending.get(pendingKey(guild.id, member.id));
  pending.delete(pendingKey(guild.id, member.id));

  const channel =
    guild.channels.cache.get(VERIFY_LOG_CHANNEL_ID) ??
    (await guild.channels.fetch(VERIFY_LOG_CHANNEL_ID).catch(() => null));
  if (!channel?.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setColor(result.color)
    .setTitle(result.title)
    .setDescription(`<@${member.id}>`);

  const fields = (acc?.entries ?? []).map((entry) => ({
    name: entry.title,
    value: entry.lines.join("\n") || "–",
    inline: false,
  }));
  embed.addFields(
    ...fields,
    { name: "Ergebnis", value: result.lines.join("\n") || result.title, inline: false },
  );

  try {
    await channel
      .send({ embeds: [embed], allowedMentions: { parse: [] } })
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