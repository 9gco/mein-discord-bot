import { ActionRowBuilder, ContainerBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, } from "discord.js";
import { loadConfig } from "../config.js";
import { createStorage } from "./storage.js";
export const DEFAULT_BANNER_URL = "https://files.catbox.moe/rqgweu.gif";
export const DEFAULT_TEAM_ROLE_ID = "1547675276656382054";
export const DEFAULT_COLOR = 0x1e9cff;
const DEFAULTS = {
    enabled: true,
    teamRoleId: DEFAULT_TEAM_ROLE_ID,
    color: DEFAULT_COLOR,
    title: "Willkommen im Ticket-System!",
    welcomeText: "Bitte wähle eine unserer Ticketkategorien aus, um ein Ticket zu erstellen.",
    noteText: "Support- und Partnerschaftsanfragen werden mithilfe einer DSGVO-konform gehosteten künstlichen Intelligenz überprüft. Nach dieser Prüfung kann eine Anfrage gegebenenfalls abgelehnt werden.",
    categories: [
        { id: "bestellung", label: "Bestellung", emoji: "🧾" },
        { id: "support", label: "Support", emoji: "👨‍🔧" },
        { id: "partnerschaft", label: "Partnerschaft", emoji: "🤝" },
    ],
};
export const ticketStore = createStorage(loadConfig(), "tickets");
export async function getTicketConfig(guildId) {
    const stored = ((await ticketStore.read(guildId)) ??
        {});
    return {
        ...DEFAULTS,
        ...stored,
        teamRoleId: typeof stored.teamRoleId === "string" && stored.teamRoleId
            ? stored.teamRoleId
            : DEFAULT_TEAM_ROLE_ID,
        color: typeof stored.color === "number" && Number.isFinite(stored.color)
            ? stored.color
            : DEFAULT_COLOR,
        title: typeof stored.title === "string" && stored.title.trim()
            ? stored.title
            : DEFAULTS.title,
        welcomeText: typeof stored.welcomeText === "string" && stored.welcomeText.trim()
            ? stored.welcomeText
            : DEFAULTS.welcomeText,
        noteText: typeof stored.noteText === "string" && stored.noteText.trim()
            ? stored.noteText
            : DEFAULTS.noteText,
        bannerUrl: typeof stored.bannerUrl === "string" && stored.bannerUrl.trim()
            ? stored.bannerUrl
            : DEFAULT_BANNER_URL,
        categories: Array.isArray(stored.categories) && stored.categories.length > 0
            ? stored.categories.map((c) => ({
                id: typeof c?.id === "string" ? c.id : `kat-${Date.now()}`,
                label: typeof c?.label === "string" && c.label ? c.label : "Kategorie",
                emoji: typeof c?.emoji === "string" && c.emoji ? c.emoji : "📁",
                ...(c?.description ? { description: c.description } : {}),
                ...(c?.teamRoleId ? { teamRoleId: c.teamRoleId } : {}),
                ...(c?.pingRoleId ? { pingRoleId: c.pingRoleId } : {}),
                ...(c?.folderId ? { folderId: c.folderId } : {}),
                ...(c?.welcomeMessage ? { welcomeMessage: c.welcomeMessage } : {}),
            }))
            : DEFAULTS.categories,
    };
}
export function findCategory(cfg, value) {
    const q = value.trim().toLowerCase();
    return cfg.categories.find((c) => c.id.toLowerCase() === q || c.label.toLowerCase() === q);
}
export function buildCategoryRow(cfg) {
    return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId("ticket:category")
        .setPlaceholder("Kategorie wählen")
        .addOptions(cfg.categories.map((c) => {
        const option = new StringSelectMenuOptionBuilder()
            .setLabel(`${c.emoji} ${c.label}`.slice(0, 100))
            .setValue(c.id.slice(0, 100));
        const desc = c.description?.trim().slice(0, 100);
        if (desc)
            option.setDescription(desc);
        return option;
    })));
}
export function buildTicketPanel(cfg, row) {
    const bullets = cfg.categories
        .map((c) => (c.description ? `${c.emoji} **${c.label}** — ${c.description}` : `${c.emoji} **${c.label}**`))
        .join("\n");
    return new ContainerBuilder()
        .setAccentColor(cfg.color)
        .addMediaGalleryComponents((gallery) => gallery.addItems((item) => item
        .setURL(cfg.bannerUrl ?? DEFAULT_BANNER_URL)
        .setDescription(`${cfg.title} — Vendetta Roleplay`.slice(0, 100))))
        .addTextDisplayComponents((text) => text.setContent(`## 📬 ${cfg.title}`))
        .addTextDisplayComponents((text) => text.setContent(cfg.welcomeText))
        .addSeparatorComponents((sep) => sep.setDivider())
        .addTextDisplayComponents((text) => text.setContent(bullets))
        .addTextDisplayComponents((text) => text.setContent(`**Hinweis:** ${cfg.noteText}`))
        .addSeparatorComponents((sep) => sep.setDivider())
        .addActionRowComponents(row);
}
