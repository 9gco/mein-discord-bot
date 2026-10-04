import { EmbedBuilder } from "discord.js";
import { loadConfig } from "../config.js";
import { createStorage } from "./storage.js";
export const DEFAULT_ROLE_IDS = [
    "1547675358948753418",
    "1547675348806803547",
];
export const DEFAULT_LOGO_URL = "https://s3.vybebot.ai/images/projects/6lQtoY60wxjr/assets/3c118c36459e6fbfd2db2f4385d9a56e2d19e133591c8b2bad9e3cc6b1aad3ed.png";
export const DEFAULT_SERVER_NAME = "Vendetta Roleplay";
const DEFAULTS = {
    enabled: true,
    logoUrl: DEFAULT_LOGO_URL,
    serverName: DEFAULT_SERVER_NAME,
    roleIds: DEFAULT_ROLE_IDS,
};
export const welcomeStore = createStorage(loadConfig(), "welcome");
export async function getWelcomeConfig(guildId) {
    const stored = ((await welcomeStore.read(guildId)) ??
        {});
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
export function buildWelcomeEmbed(cfg, memberId) {
    const logo = cfg.logoUrl;
    const serverName = cfg.serverName;
    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setAuthor({
        name: serverName.toUpperCase(),
        ...(logo ? { iconURL: logo } : {}),
    })
        .setTitle("Willkommen")
        .setDescription(`👋 <@${memberId}> willkommen auf **${serverName}**! 🎉\n\n` +
        `Bevor du loslegst, wirf bitte einen kurzen Blick in unser Regelwerk, ` +
        `um dir den Start so angenehm wie möglich zu machen und Missverständnisse ` +
        `zu vermeiden. Die Regeln gelten für alle und sind der Schlüssel zu einem ` +
        `langen und positiven Aufenthalt auf unserem Server. Lies sie dir aufmerksam durch!\n\n` +
        `Viel Spaß und eine großartige Zeit auf unserem Server! 🚀`)
        .setFooter({ text: `Built with VybeBot.ai | ${serverName}` })
        .setTimestamp();
    if (logo)
        embed.setThumbnail(logo);
    if (cfg.bannerUrl)
        embed.setImage(cfg.bannerUrl);
    return embed;
}
