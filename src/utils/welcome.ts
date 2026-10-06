import { EmbedBuilder } from "discord.js";
import { loadConfig } from "../config.js";
import { createStorage } from "./storage.js";

/**
 * Rollen, die neuen Mitgliedern standardmäßig automatisch zugewiesen werden.
 * Das Verify-System vergibt selbst keine Rolle mehr – das Sprechrecht hängt
 * direkt an den Kanalrechten des Mitglieds.
 */
export const DEFAULT_ROLE_IDS = ["1547675348806803547"];

/** Logo, das als Server-Logo oben rechts (Thumbnail) verwendet wird. */
export const DEFAULT_LOGO_URL = "";

export const DEFAULT_SERVER_NAME = "Vendetta Roleplay";

export interface WelcomeConfig {
  enabled: boolean;
  /** Kanal-ID, in den die Willkommensnachricht gepostet wird. */
  channelId?: string;
  /** URL des Willkommens-/Banner-Bilds (auch als GIF erlaubt). */
  bannerUrl?: string;
  /** URL des Logos, oben rechts im Embed. */
  logoUrl?: string;
  /** Server-Name, der in Header/Footer erscheint. */
  serverName: string;
  /** Rollen-IDs, die neuen Mitgliedern zugewiesen werden. */
  roleIds: string[];
}

const DEFAULTS: Omit<WelcomeConfig, "channelId" | "bannerUrl"> = {
  enabled: true,
  logoUrl: DEFAULT_LOGO_URL,
  serverName: DEFAULT_SERVER_NAME,
  roleIds: DEFAULT_ROLE_IDS,
};

/** Pro-Guild gespeicherte Willkommens-Einstellungen. */
export const welcomeStore = createStorage<WelcomeConfig>(
  loadConfig(),
  "welcome",);

/**
 * Liest die Willkommens-Config eines Servers. Gespeicherte Daten können älter
 * als das aktuelle Interface sein, deshalb werden Arrays/Objekte normalisiert.
 */
export async function getWelcomeConfig(guildId: string): Promise<WelcomeConfig> {
  const stored = ((await welcomeStore.read(guildId)) ??
    {}) as Partial<WelcomeConfig>;
  return {
    ...DEFAULTS,
    ...stored,
    serverName: stored.serverName?.trim() ? stored.serverName : DEFAULTS.serverName,
    logoUrl: stored.logoUrl?.trim() ? stored.logoUrl : DEFAULTS.logoUrl,
    roleIds: Array.isArray(stored.roleIds) && stored.roleIds.length > 0
      ? stored.roleIds
      : DEFAULT_ROLE_IDS,
  };
}

/** Legt die Willkommensnachricht im Stil der Vorlage an. */
export function buildWelcomeEmbed(
  cfg: WelcomeConfig,
  memberId: string,
): EmbedBuilder {
  const logo = cfg.logoUrl;
  const serverName = cfg.serverName;

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setAuthor({
      name: serverName.toUpperCase(),
      ...(logo ? { iconURL: logo } : {}),
    })
    .setTitle("Willkommen")
    .setDescription(
      `👋 <@${memberId}> willkommen auf **${serverName}**! 🎉\n\n` +
        `Bevor du loslegst wirf bitte einen kurzen Blick in unser Regelwerk ` +
        `um dir den Start so angenehm wie möglich zu machen und Missverständnisse ` +
        `zu vermeiden. Die Regeln gelten für alle und sind der Schlüssel zu einem ` +
        `langen und positiven Aufenthalt auf unserem Server. Lies sie dir aufmerksam durch!\n\n` +
        `Viel Spaß und eine großartige Zeit auf unserem Server! 🚀`,
    )
    .setTimestamp();

  if (logo) embed.setThumbnail(logo);
  if (cfg.bannerUrl) embed.setImage(cfg.bannerUrl);

  return embed;
}