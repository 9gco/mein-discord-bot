import {
  ActionRowBuilder,
  ContainerBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type StringSelectMenuBuilder as StringSelectMenuBuilderType,
} from "discord.js";
import { loadConfig } from "../config.js";
import { createStorage } from "./storage.js";

/** Standard-Banner (GIF) für das Ticket-Panel. */
export const DEFAULT_BANNER_URL = "https://files.catbox.moe/rqgweu.gif";
/** Standard-Team-Rolle, die Zugriff auf Tickets bekommt. */
export const DEFAULT_TEAM_ROLE_ID = "1547675276656382054";
/** Akzentfarbe (blau) – erzeugt die linke Akzentleiste. */
export const DEFAULT_COLOR = 0x1e9cff;

export interface TicketCategory {
  id: string;
  label: string;
  emoji: string;
  description?: string;
  /** Optionale Team-Rolle nur für diese Kategorie (sonst globale Team-Rolle). */
  teamRoleId?: string;
  /** Optionale Ping-Rolle nur für diese Kategorie (sonst globale Ping-Rolle). */
  pingRoleId?: string;
  /** Optionaler Ordner (Kategorie) nur für die Tickets dieser Kategorie. */
  folderId?: string;
  /** Optionaler Begrüßungstext im erstellten Ticket. */
  welcomeMessage?: string;
}

export interface TicketConfig {
  enabled: boolean;
  /** Kanal, in dem das Panel stehen soll. */
  channelId?: string;
  /** Optische Kategorie (Ordner), in der Ticket-Kanäle erstellt werden. */
  folderId?: string;
  /** Team-Rolle mit Zugriff auf alle Tickets. */
  teamRoleId: string;
  /** Rolle, die beim neuen Ticket gepingt wird (optional). */
  pingRoleId?: string;
  bannerUrl?: string;
  /** Embed-/Akzentfarbe als Zahl (hex). */
  color: number;
  title: string;
  welcomeText: string;
  noteText: string;
  categories: TicketCategory[];
}

const DEFAULTS: Omit<
  TicketConfig,
  "channelId" | "folderId" | "pingRoleId" | "bannerUrl"
> = {
  enabled: true,
  teamRoleId: DEFAULT_TEAM_ROLE_ID,
  color: DEFAULT_COLOR,
  title: "Willkommen im Ticket-System!",
  welcomeText:
    "Bitte wähle eine unserer Ticketkategorien aus um ein Ticket zu erstellen.",
  noteText:
    "Support- und Partnerschaftsanfragen werden mithilfe einer DSGVO-konform gehosteten künstlichen Intelligenz überprüft. Nach dieser Prüfung kann eine Anfrage gegebenenfalls abgelehnt werden.",
  categories: [
    { id: "bestellung", label: "Bestellung", emoji: "🧾" },
    { id: "support", label: "Support", emoji: "👨‍🔧" },
    { id: "partnerschaft", label: "Partnerschaft", emoji: "🤝" },
  ],
};

/** Pro-Guild gespeicherte Ticket-Einstellungen. */
export const ticketStore = createStorage<TicketConfig>(loadConfig(), "tickets");

/** Liest die Ticket-Config eines Servers und normalisiert alte Daten. */
export async function getTicketConfig(guildId: string): Promise<TicketConfig> {
  const stored = ((await ticketStore.read(guildId)) ??
    {}) as Partial<TicketConfig>;
  return {
    ...DEFAULTS,
    ...stored,
    teamRoleId:
      typeof stored.teamRoleId === "string" && stored.teamRoleId
        ? stored.teamRoleId
        : DEFAULT_TEAM_ROLE_ID,
    color:
      typeof stored.color === "number" && Number.isFinite(stored.color)
        ? stored.color
        : DEFAULT_COLOR,
    title:
      typeof stored.title === "string" && stored.title.trim()
        ? stored.title
        : DEFAULTS.title,
    welcomeText:
      typeof stored.welcomeText === "string" && stored.welcomeText.trim()
        ? stored.welcomeText
        : DEFAULTS.welcomeText,
    noteText:
      typeof stored.noteText === "string" && stored.noteText.trim()
        ? stored.noteText
        : DEFAULTS.noteText,
    bannerUrl:
      typeof stored.bannerUrl === "string" && stored.bannerUrl.trim()
        ? stored.bannerUrl
        : DEFAULT_BANNER_URL,
    categories:
      Array.isArray(stored.categories) && stored.categories.length > 0
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

/** Sucht eine Kategorie anhand von ID oder (case-insensitive) Label. */
export function findCategory(
  cfg: TicketConfig,
  value: string,
): TicketCategory | undefined {
  const q = value.trim().toLowerCase();
  return cfg.categories.find(
    (c) => c.id.toLowerCase() === q || c.label.toLowerCase() === q,
  );
}

/** Erstellt die Auswahl (Dropdown) mit allen Kategorien. */
export function buildCategoryRow(cfg: TicketConfig): ActionRowBuilder<StringSelectMenuBuilderType> {
  // Discord begrenzt Select-Optionen auf 100 Zeichen (Label & Beschreibung).
  // Selbst lange, benutzerdefinierte Kategorien dürfen nie crashen.
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ticket:category")
      .setPlaceholder("Kategorie wählen")
      .addOptions(
        cfg.categories.map((c) => {
          const option = new StringSelectMenuOptionBuilder()
            .setLabel(`${c.emoji} ${c.label}`.slice(0, 100))
            .setValue(c.id.slice(0, 100));
          const desc = c.description?.trim().slice(0, 100);
          if (desc) option.setDescription(desc);
          return option;
        }),
      ),
  );
}

/**
 * Baut das Ticket-Panel (Components V2) im Stil der Vorlage:
 * Banner oben, Titel, Beschreibung, Kategorienliste, Hinweis, Dropdown.
 */
export function buildTicketPanel(
  cfg: TicketConfig,
  row: ActionRowBuilder<StringSelectMenuBuilderType>,
): ContainerBuilder {
  const bullets = cfg.categories
    .map((c) => (c.description ? `${c.emoji} **${c.label}** — ${c.description}` : `${c.emoji} **${c.label}**`))
    .join("\n");

  return new ContainerBuilder()
    .setAccentColor(cfg.color)
    .addMediaGalleryComponents((gallery) =>
      gallery.addItems((item) =>
        item
          .setURL(cfg.bannerUrl ?? DEFAULT_BANNER_URL)
          .setDescription(`${cfg.title} — Vendetta Roleplay`.slice(0, 100)),
      ),
    )
    .addTextDisplayComponents((text) =>
      text.setContent(`## 📬 ${cfg.title}`),
    )
    .addTextDisplayComponents((text) => text.setContent(cfg.welcomeText))
    .addSeparatorComponents((sep) => sep.setDivider())
    .addTextDisplayComponents((text) => text.setContent(bullets))
    .addTextDisplayComponents((text) =>
      text.setContent(`**Hinweis:** ${cfg.noteText}`),
    )
    .addSeparatorComponents((sep) => sep.setDivider())
    .addActionRowComponents(row);
}
