import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  ChannelType,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  RoleSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type GuildChannel,
} from "discord.js";
import { logger } from "../utils/logger.js";
import type { BotCommand } from "./index.js";
import {
  ticketStore,
  getTicketConfig,
  buildCategoryRow,
  buildTicketPanel,
  findCategory,
  type TicketConfig,
  type TicketCategory,
} from "../utils/tickets.js";

const PANEL_FLAGS = MessageFlags.IsComponentsV2;

function sanitizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 32) || "ticket";
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || `kat${Date.now()}`;
}

function parseColor(value: string): number | null {
  const hex = value.replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return parseInt(hex, 16);
}

/** Öffnet ein Formular, um eine einzelne Kategorie komplett anzupassen. */
function buildCategoryEditModal(category: TicketCategory): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`ticket:cat:edit:${category.id}`)
    .setTitle(`Kategorie: ${category.label}`)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Emoji")
        .setDescription("Zeichen vor dem Namen.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("emoji")
            .setStyle(TextInputStyle.Short)
            .setValue(category.emoji)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel("Name")
        .setDescription("Name der Kategorie.")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("label")
            .setStyle(TextInputStyle.Short)
            .setValue(category.label)
            .setRequired(true),
        ),
      new LabelBuilder()
        .setLabel("Team-Rolle")
        .setDescription("Leer lassen = globale Team-Rolle.")
        .setRoleSelectMenuComponent(
          new RoleSelectMenuBuilder()
            .setCustomId("teamRole")
            .setPlaceholder("Team-Rolle für diese Kategorie")
            .setMinValues(0)
            .setRequired(false),
        ),
      new LabelBuilder()
        .setLabel("Ping-Rolle")
        .setDescription("Leer lassen = globale Ping-Rolle.")
        .setRoleSelectMenuComponent(
          new RoleSelectMenuBuilder()
            .setCustomId("pingRole")
            .setPlaceholder("Ping-Rolle für diese Kategorie")
            .setMinValues(0)
            .setRequired(false),
        ),
      new LabelBuilder()
        .setLabel("Willkommenstext")
        .setDescription("Startnachricht im Ticket (optional).")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId("welcome")
            .setStyle(TextInputStyle.Paragraph)
            .setValue(category.welcomeMessage ?? "")
            .setPlaceholder("Leer lassen = Standardtext.")
            .setRequired(false),
        ),
    );
}

const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Ticket-System einrichten und Tickets erstellen.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("panel")
        .setDescription(
          "Sendet das Ticket-Panel in den konfigurierten Kanal.",
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("preview")
        .setDescription("Zeigt dir eine Vorschau des Panels."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("Ticket-System ein- oder ausschalten.")
        .addBooleanOption((o) =>
          o.setName("enabled").setDescription("An oder aus.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("channel")
        .setDescription("Wählt den Kanal für das Ticket-Panel.")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Kanal, in dem das Panel erscheint.")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("folder")
        .setDescription("Ordner für neue Ticket-Kanäle.")
        .addChannelOption((o) =>
          o
            .setName("category")
            .setDescription("Kategorie (Ordner) für Ticket-Kanäle.")
            .addChannelTypes(ChannelType.GuildCategory)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("team")
        .setDescription("Setzt die Team-Rolle mit Ticket-Zugriff.")
        .addRoleOption((o) =>
          o.setName("role").setDescription("Die Team-/Staff-Rolle.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("ping")
        .setDescription("Rolle, die bei Tickets gepingt wird.")
        .addRoleOption((o) =>
          o
            .setName("role")
            .setDescription("Zu pingen. Weglassen zum Deaktivieren."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("banner")
        .setDescription("Banner des Panels setzen (Upload/URL).")
        .addAttachmentOption((o) =>
          o.setName("file").setDescription("Bilddatei (PNG/JPG/WEBP/GIF)."),
        )
        .addStringOption((o) =>
          o.setName("url").setDescription("Direktlink zum Banner."),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("color")
        .setDescription("Setzt die Akzentfarbe (hex, z. B. 1E9CFF).")
        .addStringOption((o) =>
          o
            .setName("hex")
            .setDescription("Hex-Wert ohne #, z. B. 1E9CFF.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("text")
        .setDescription("Bearbeitet Titel, Willkommenstext und Hinweis.")
    )
    .addSubcommandGroup((group) =>
      group
        .setName("category")
        .setDescription("Verwaltet die Ticket-Kategorien.")
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Fügt eine Kategorie hinzu.")
            .addStringOption((o) =>
              o
                .setName("name")
                .setDescription("Name der Kategorie, z. B. Support.")
                .setRequired(true),
            )
            .addStringOption((o) =>
              o
                .setName("emoji")
                .setDescription("Emoji, z. B. 👨‍🔧.")
                .setRequired(true),
            )
            .addStringOption((o) =>
              o
                .setName("description")
                .setDescription("Kurze Beschreibung (optional)."),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("edit")
            .setDescription("Konfiguriert eine Kategorie im Detail.")
            .addStringOption((o) =>
              o
                .setName("name")
                .setDescription("Name oder ID der Kategorie.")
                .setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("folder")
            .setDescription("Ordner für Tickets dieser Kategorie festlegen.")
            .addStringOption((o) =>
              o
                .setName("name")
                .setDescription("Name oder ID der Kategorie.")
                .setRequired(true),
            )
            .addChannelOption((o) =>
              o
                .setName("category")
                .setDescription("Ordner. Weglassen = globalen Ordner nutzen.")
                .addChannelTypes(ChannelType.GuildCategory),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Entfernt eine Kategorie (Name oder ID).")
            .addStringOption((o) =>
              o.setName("name").setDescription("Name oder ID der Kategorie.").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("Zeigt alle Kategorien."),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content:
          "Du benötigst die Berechtigung „Server verwalten“, um das Ticket-System zu verwalten.",
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

    // Panel/Paged – direkt senden (sendet das fertige Components-V2-Panel).
    if (sub === "panel") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const cfg = await getTicketConfig(guildId);
      const target = cfg.channelId
        ? guild.channels.cache.get(cfg.channelId)
        : null;
      const panel = buildTicketPanel(cfg, buildCategoryRow(cfg));

      if (target?.isTextBased()) {
        await target.send({
          components: [panel],
          flags: PANEL_FLAGS,
        });
        await interaction.editReply({
          content: `Panel wurde in <#${target.id}> gesendet.`,
        });
      } else {
        await interaction.editReply({
          content:
            "Kein Kanal konfiguriert. Setze zuerst `/ticket channel <Kanal>`.",
        });
      }
      return;
    }

    if (sub === "preview") {
      const cfg = await getTicketConfig(guildId);
      const panel = buildTicketPanel(cfg, buildCategoryRow(cfg));
      await interaction.reply({
        components: [panel],
        flags: PANEL_FLAGS | MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    // Kategorie-Detailkonfiguration → Modal öffnen.
    if (group === "category" && sub === "edit") {
      const cfg = await getTicketConfig(guildId);
      const query = interaction.options.getString("name", true);
      const category = findCategory(cfg, query);
      if (!category) {
        await interaction.reply({
          content: `Kategorie „${query}“ nicht gefunden. Nutze \`/ticket category list\`.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.showModal(buildCategoryEditModal(category));
      return;
    }

    // Texte bearbeiten → Modal öffnen (muss als Erstes kommen).
    if (sub === "text") {
      const cfg = await getTicketConfig(guildId);
      const modal = new ModalBuilder()
        .setCustomId("ticket:text:edit")
        .setTitle("Ticket-Panel Texte")
        .addLabelComponents(
          new LabelBuilder()
            .setLabel("Titel")
            .setDescription("Überschrift des Panels.")
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId("title")
                .setStyle(TextInputStyle.Short)
                .setValue(cfg.title)
                .setRequired(true),
            ),
          new LabelBuilder()
            .setLabel("Willkommenstext")
            .setDescription("Text unter der Überschrift.")
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId("welcome")
                .setStyle(TextInputStyle.Paragraph)
                .setValue(cfg.welcomeText)
                .setRequired(false),
            ),
          new LabelBuilder()
            .setLabel("Hinweis")
            .setDescription("Text hinter dem Wort Hinweis.")
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId("note")
                .setStyle(TextInputStyle.Paragraph)
                .setValue(cfg.noteText)
                .setRequired(false),
            ),
        );
      await interaction.showModal(modal);
      return;
    }

    // Alle anderen: lesen/schreiben Storage → erst dehnen.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = await getTicketConfig(guildId);
    const saved = { ...cfg };
    let message = "";

    try {
      if (sub === "toggle") {
        saved.enabled = interaction.options.getBoolean("enabled", true);
        message = saved.enabled
          ? "Ticket-System ist jetzt **aktiviert**."
          : "Ticket-System ist jetzt **deaktiviert**.";
      } else if (sub === "channel") {
        saved.channelId = interaction.options.getChannel("channel", true).id;
        message = `Panel-Kanal: <#${saved.channelId}>`;
      } else if (sub === "folder" && group !== "category") {
        saved.folderId = interaction.options.getChannel("category", true).id;
        message = `Ticket-Kanäle werden in <#${saved.folderId}> erstellt.`;
      } else if (sub === "team") {
        saved.teamRoleId = interaction.options.getRole("role", true).id;
        message = `Team-Rolle: <@&${saved.teamRoleId}>`;
      } else if (sub === "ping") {
        const role = interaction.options.getRole("role");
        if (role) {
          saved.pingRoleId = role.id;
          message = `Ping-Rolle bei neuen Tickets: <@&${role.id}>`;
        } else {
          saved.pingRoleId = undefined;
          message = "Ping-Rolle deaktiviert.";
        }
      } else if (sub === "banner") {
        const file = interaction.options.getAttachment("file");
        const url = interaction.options.getString("url");
        const value = file?.url?.trim() || url?.trim() || "";
        if (!value) {
          saved.bannerUrl = undefined;
          message = "Banner zurückgesetzt (Standard wird verwendet).";
        } else if (/^https?:\/\//i.test(value)) {
          saved.bannerUrl = value;
          message = "Banner gesetzt.";
        } else {
          await interaction.editReply({
            content:
              "Ungültige URL. Bitte Datei hochladen oder Direktlink (http/https) angeben.",
          });
          return;
        }
      } else if (sub === "color") {
        const parsed = parseColor(interaction.options.getString("hex", true));
        if (parsed === null) {
          await interaction.editReply({
            content: "Ungültiger Hex-Wert. Beispiel: `1E9CFF`.",
          });
          return;
        }
        saved.color = parsed;
        message = `Akzentfarbe gesetzt: #${parsed.toString(16).toUpperCase()}`;
      } else if (group === "category") {
        if (sub === "folder") {
          const query = interaction.options.getString("name", true);
          const category = findCategory(saved, query);
          if (!category) {
            await interaction.editReply({
              content: `Kategorie „${query}“ nicht gefunden.`,
            });
            return;
          }
          const index = saved.categories.findIndex((c) => c.id === category.id);
          const folder = interaction.options.getChannel("category");
          const updatedCategory = { ...category };
          if (folder) {
            updatedCategory.folderId = folder.id;
            message = `Tickets der Kategorie „${updatedCategory.label}“ → Ordner <#${folder.id}>.`;
          } else {
            updatedCategory.folderId = undefined;
            message = `Ordner für „${updatedCategory.label}“ zurückgesetzt (globaler Ordner).`;
          }
          if (index >= 0) saved.categories[index] = updatedCategory;
        } else if (sub === "add") {
          const name = interaction.options.getString("name", true);
          const emoji = interaction.options.getString("emoji", true);
          const description = interaction.options.getString("description");
          saved.categories.push({
            id: slugify(name),
            label: name,
            emoji,
            ...(description ? { description } : {}),
          });
          message = `Kategorie „${emoji} ${name}“ hinzugefügt.`;
        } else if (sub === "remove") {
          const name = interaction.options.getString("name", true).toLowerCase();
          const before = saved.categories.length;
          saved.categories = saved.categories.filter(
            (c) =>
              c.id.toLowerCase() !== name && c.label.toLowerCase() !== name,
          );
          message =
            before === saved.categories.length
              ? "Keine passende Kategorie gefunden."
              : "Kategorie entfernt.";
        } else {
          message =
            saved.categories.length > 0
              ? `Kategorien:\n${saved.categories
                  .map((c) => `${c.emoji} **${c.label}** (\`${c.id}\`)`)
                  .join("\n")}`
              : "Keine Kategorien vorhanden.";
        }
      }

      await ticketStore.write(guildId, saved);
      await interaction.editReply({ content: message });
    } catch (err) {
      logger.error("Fehler beim Konfigurieren des Ticket-Systems.", {
        guildId,
        error: err,
      });
      await interaction.editReply({
        content: "Beim Speichern ist ein unerwarteter Fehler aufgetreten.",
      });
    }
  },

  async stringSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    if (interaction.customId !== "ticket:category") return;

    const guild = interaction.guild;
    if (!guild) return;

    const guildId = guild.id;
    const cfg = await getTicketConfig(guildId);
    if (!cfg.enabled) {
      await interaction.reply({
        content: "Das Ticket-System ist derzeit deaktiviert.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const categoryId = interaction.values[0];
    const category = cfg.categories.find((c) => c.id === categoryId);
    if (!category) {
      await interaction.reply({
        content: "Diese Kategorie existiert nicht mehr.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const member = interaction.member;
      const name = sanitizeName(member?.user.username ?? interaction.user.username);
      // Kategorie-spezifische Werte, sonst globale Einstellungen.
      const effTeamRole = category.teamRoleId ?? cfg.teamRoleId;
      const effPingRole = category.pingRoleId ?? cfg.pingRoleId ?? undefined;
      const welcomeMessage =
        category.welcomeMessage?.trim() ??
        `Hey <@${interaction.user.id}>! Dein Ticket wurde erstellt.\n` +
          `Unser Team wird sich so schnell wie möglich um dein Anliegen kümmern. ` +
          `Bitte beschreibe dein Anliegen hier unten.\n\n` +
          `**Vendetta Roleplay**`;

      const overwrites: { id: string; allow?: bigint; deny?: bigint }[] = [
        {
          id: guild.roles.everyone.id,
          deny: PermissionFlagsBits.ViewChannel,
        },
        {
          id: interaction.user.id,
          allow:
            PermissionFlagsBits.ViewChannel |
            PermissionFlagsBits.SendMessages |
            PermissionFlagsBits.ReadMessageHistory |
            PermissionFlagsBits.AttachFiles |
            PermissionFlagsBits.EmbedLinks |
            PermissionFlagsBits.AddReactions,
        },
      ];

      if (effTeamRole) {
        overwrites.push({
          id: effTeamRole,
          allow:
            PermissionFlagsBits.ViewChannel |
            PermissionFlagsBits.SendMessages |
            PermissionFlagsBits.ReadMessageHistory |
            PermissionFlagsBits.ManageMessages |
            PermissionFlagsBits.ManageChannels,
        });
      }

      const client = interaction.client;
      if (client.user) {
        overwrites.push({
          id: client.user.id,
          allow:
            PermissionFlagsBits.ViewChannel |
            PermissionFlagsBits.SendMessages |
            PermissionFlagsBits.ReadMessageHistory |
            PermissionFlagsBits.ManageChannels,
        });
      }

      const channel = await guild.channels.create({
        name: `ticket-${name}`,
        type: ChannelType.GuildText,
        parent: (category.folderId ?? cfg.folderId) ?? undefined,
        permissionOverwrites: overwrites,
        topic: `Ticket: ${category.label} — ${interaction.user.tag}`,
        reason: `Ticket erstellt (${category.label})`,
      });

      const intro = new EmbedBuilder()
        .setColor(cfg.color)
        .setTitle(`${category.emoji} ${category.label}`)
        .setDescription(welcomeMessage)
        
        .setTimestamp();

      const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:close")
          .setLabel("🔒 Ticket schließen")
          .setStyle(ButtonStyle.Danger),
      );

      const ping = effPingRole ? `<@&${effPingRole}> ` : "";
      await channel.send({
        content: `${ping}<@${interaction.user.id}>`,
        embeds: [intro],
        components: [closeRow],
        allowedMentions: { parse: ["users", "roles"] },
      });

      await interaction.editReply({
        content: `Dein Ticket ist erstellt: <#${channel.id}>`,
      });
    } catch (err) {
      logger.error("Ticket-Erstellung fehlgeschlagen.", {
        guildId,
        categoryId,
        error: err,
      });
      await interaction.editReply({
        content:
          "Das Ticket konnte nicht erstellt werden. Bitte prüfe die Bot-Berechtigungen (Kanäle verwalten).",
      });
    }
  },

  async button(interaction: ButtonInteraction): Promise<void> {
    const [commandName, action, decision] = interaction.customId.split(":");
    if (commandName !== "ticket") return;

    if (action === "close" && !decision) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("ticket:close:confirm")
          .setLabel("Ja, schließen")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("ticket:close:cancel")
          .setLabel("Abbrechen")
          .setStyle(ButtonStyle.Secondary),
      );
      await interaction.reply({
        content: "Möchtest du dieses Ticket wirklich schließen?",
        components: [row],
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (action === "close" && decision === "confirm") {
      await interaction.reply({
        content: "Ticket wird geschlossen…",
        flags: MessageFlags.Ephemeral,
      });
      const channel = interaction.channel;
      if (channel && "delete" in channel) {
        await (channel as GuildChannel).delete("Ticket geschlossen");
      }
      return;
    }

    if (action === "close" && decision === "cancel") {
      await interaction.update({
        content: "Schließen abgebrochen.",
        components: [],
      });
    }
  },

  async modal(interaction: ModalSubmitInteraction): Promise<void> {
    const parts = interaction.customId.split(":");
    const commandName = parts[0];
    if (commandName !== "ticket") return;

    // Kategorie-Detailformular: ticket:cat:edit:<categoryId>
    if (parts[1] === "cat" && parts[2] === "edit") {
      const categoryId = parts.slice(3).join(":") || "";
      const guild = interaction.guild;
      if (!guild) return;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guildId = guild.id;
      const cfg = await getTicketConfig(guildId);
      const cat = cfg.categories.find((c) => c.id === categoryId);
      if (!cat) {
        await interaction.editReply({
          content: "Diese Kategorie existiert nicht mehr.",
        });
        return;
      }

      const emoji = interaction.fields.getTextInputValue("emoji")?.trim() ?? "";
      const label = interaction.fields.getTextInputValue("label")?.trim() ?? "";
      const teamPick = interaction.fields.fields.has("teamRole")
        ? interaction.fields.getSelectedRoles("teamRole", true)
        : undefined;
      const pingPick = interaction.fields.fields.has("pingRole")
        ? interaction.fields.getSelectedRoles("pingRole", true)
        : undefined;
      const msg = interaction.fields.fields.has("welcome")
        ? (interaction.fields.getTextInputValue("welcome")?.trim() ?? "")
        : "";

      if (emoji) cat.emoji = emoji;
      if (label) {
        const newId = slugify(label);
        cat.label = label;
        cat.id = newId || cat.id;
      }
      // Leer lassen (keine Rolle gewählt) = Auswahl zurücksetzen → globale Rolle.
      const teamFirst = teamPick && teamPick.size > 0 ? teamPick.first() : undefined;
      const pingFirst = pingPick && pingPick.size > 0 ? pingPick.first() : undefined;
      cat.teamRoleId = teamFirst && "id" in teamFirst ? teamFirst.id : undefined;
      cat.pingRoleId = pingFirst && "id" in pingFirst ? pingFirst.id : undefined;
      cat.welcomeMessage = msg || undefined;

      await ticketStore.write(guildId, cfg);
      await interaction.editReply({
        content: `Kategorie „${cat.emoji} ${cat.label}“ aktualisiert.\nSende das Panel neu mit \`/ticket panel\`.`,
      });
      return;
    }

    if (interaction.customId !== "ticket:text:edit") return;

    const guild = interaction.guild;
    if (!guild) return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = guild.id;
    const cfg = await getTicketConfig(guildId);

    const title = interaction.fields.getTextInputValue("title")?.trim() ?? "";
    const welcome = interaction.fields.fields.has("welcome")
      ? interaction.fields.getTextInputValue("welcome")?.trim() ?? ""
      : "";
    const note = interaction.fields.fields.has("note")
      ? interaction.fields.getTextInputValue("note")?.trim() ?? ""
      : "";

    const updates: Partial<TicketConfig> = {};
    if (title) updates.title = title;
    if (welcome) updates.welcomeText = welcome;
    if (note) updates.noteText = note;

    await ticketStore.write(guildId, { ...cfg, ...updates });
    await interaction.editReply({
      content: "Texte gespeichert. Sende das Panel neu mit `/ticket panel`.",
    });
  },
};

export default command;
