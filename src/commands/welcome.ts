import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../utils/logger.js";
import type { BotCommand } from "./index.js";
import {
  welcomeStore,
  getWelcomeConfig,
  buildWelcomeEmbed,
} from "../utils/welcome.js";

function isValidMediaUrl(value: string | undefined | null): boolean {
  if (!value) return false;
  return /^https?:\/\//i.test(value);
}

function normalizeRoles(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((r) => typeof r === "string") : [];
}

const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("welcome")
    .setDescription(
      "Willkommensnachricht & automatische Rollenvergabe konfigurieren.",
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription(
          "Willkommenssystem ein- oder ausschalten.",
        )
        .addBooleanOption((o) =>
          o
            .setName("enabled")
            .setDescription("Aktiviert oder deaktiviert das System.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("banner")
        .setDescription(
          "Setzt das Willkommens-/Bannerbild (Datei-Upload oder URL auch GIF).",
        )
        .addAttachmentOption((o) =>
          o
            .setName("file")
            .setDescription("Bilddatei hochladen (PNG/JPG/WEBP/GIF)."),
        )
        .addStringOption((o) =>
          o
            .setName("url")
            .setDescription("Direktlink zum Banner (http/https auch .gif)."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("logo")
        .setDescription(
          "Setzt das Logo oben rechts (Datei-Upload oder URL).",
        )
        .addAttachmentOption((o) =>
          o
            .setName("file")
            .setDescription("Logodatei hochladen (PNG/JPG/WEBP)."),
        )
        .addStringOption((o) =>
          o.setName("url").setDescription("Direktlink zum Logo (http/https)."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("channel")
        .setDescription("Wählt den Kanal für die Willkommensnachricht.")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Kanal in den Willkommensnachrichten gehen.")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("server")
        .setDescription("Setzt den Server-Namen in der Willkommensnachricht.")
        .addStringOption((o) =>
          o
            .setName("name")
            .setDescription("Anzeigename des Servers.")
            .setRequired(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("role")
        .setDescription("Verwaltet die Rollen die neue Mitglieder erhalten.")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Fügt eine automatisch zuweisende Rolle hinzu.")
            .addRoleOption((o) =>
              o
                .setName("role")
                .setDescription("Die Rolle die automatisch vergeben wird.")
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Entfernt eine automatisch zuweisende Rolle.")
            .addRoleOption((o) =>
              o
                .setName("role")
                .setDescription("Die Rolle die entfernt werden soll.")
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("Zeigt die konfigurierten Rollen an."),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("preview").setDescription("Sendet eine Vorschau der Willkommensnachricht."),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content:
          "Du benötigst die Berechtigung „Server verwalten“ um das Willkommenssystem einzurichten.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "Dieses Kommando funktioniert nur in einem Server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = guild.id;
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(true);

    // Vorschau antwortet sofort (zeigt ein Beispiel mit eigenem Serverwert).
    if (sub === "preview") {
      const cfg = await getWelcomeConfig(guildId);
      const embed = buildWelcomeEmbed(cfg, interaction.user.id);
      await interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Alle anderen Subcommands lesen/schreiben Storage → erst dehnen.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const cfg = await getWelcomeConfig(guildId);
    let saved = { ...cfg };
    let message = "";

    try {
      if (group === "role") {
        if (sub === "add" || sub === "remove") {
          const roleId = interaction.options.getRole("role", true).id;
          const roles = normalizeRoles(saved.roleIds);
          const idx = roles.indexOf(roleId);

          if (sub === "add") {
            if (idx === -1) {
              roles.push(roleId);
              saved.roleIds = roles;
              message = `Rolle <@&${roleId}> wird neuen Mitgliedern automatisch zugewiesen.`;
            } else {
              message = "Diese Rolle ist bereits konfiguriert.";
            }
          } else {
            if (idx !== -1) {
              roles.splice(idx, 1);
              saved.roleIds = roles;
              message = `Rolle <@&${roleId}> wurde entfernt.`;
            } else {
              message = "Diese Rolle ist nicht konfiguriert.";
            }
          }
        } else {
          // list
          const roles = normalizeRoles(saved.roleIds);
          message =
            roles.length > 0
              ? `Automatisch vergebene Rollen:\n${roles
                  .map((id) => `<@&${id}>`)
                  .join("\n")}`
              : "Es sind keine Rollen konfiguriert.";
        }
      } else if (sub === "toggle") {
        saved.enabled = interaction.options.getBoolean("enabled", true);
        message = saved.enabled
          ? "Willkommenssystem ist jetzt **aktiviert**."
          : "Willkommenssystem ist jetzt **deaktiviert**.";
      } else if (sub === "channel") {
        saved.channelId = interaction.options.getChannel("channel", true).id;
        message = `Willkommensnachrichten werden künftig in <#${saved.channelId}> gepostet.`;
      } else if (sub === "server") {
        saved.serverName = interaction.options.getString("name", true);
        message = `Server-Name gesetzt: **${saved.serverName}**`;
      } else if (sub === "banner") {
        const file = interaction.options.getAttachment("file");
        const url = interaction.options.getString("url");
        const value = file?.url?.trim() || url?.trim() || "";

        if (!value) {
          saved.bannerUrl = undefined;
          message =
            "Banner entfernt. Setze es neu mit `/welcome banner` (Datei-Upload oder URL).";
        } else if (isValidMediaUrl(value)) {
          saved.bannerUrl = value;
          message = "Banner gesetzt — wird als großes Bild am unteren Rand angezeigt.";
        } else {
          await interaction.editReply({
            content: "Ungültige URL. Bitte eine Datei hochladen oder einen Direktlink (http/https) angeben.",
          });
          return;
        }
      } else if (sub === "logo") {
        const file = interaction.options.getAttachment("file");
        const url = interaction.options.getString("url");
        const value = file?.url?.trim() || url?.trim() || "";

        if (!value) {
          saved.logoUrl = undefined;
          message = "Logo zurückgesetzt (Standard-Logo wird verwendet).";
        } else if (isValidMediaUrl(value)) {
          saved.logoUrl = value;
          message = "Logo gesetzt — erscheint oben rechts im Embed.";
        } else {
          await interaction.editReply({
            content: "Ungültige URL. Bitte eine Datei hochladen oder einen Direktlink (http/https) angeben.",
          });
          return;
        }
      }

      saved = {
        ...saved,
        roleIds: normalizeRoles(saved.roleIds),
      };

      await welcomeStore.write(guildId, saved);
      await interaction.editReply({ content: message });
    } catch (err) {
      logger.error("Fehler beim Konfigurieren des Willkommenssystems.", {
        guildId,
        error: err,
      });
      await interaction.editReply({
        content: "Beim Speichern ist ein unerwarteter Fehler aufgetreten.",
      });
    }
  },
};

export default command;
