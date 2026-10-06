import {
  ChannelType,
  MessageFlags,
  ModalBuilder,
  LabelBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { logger } from "../utils/logger.js";
import {
  connectToVerifyChannel,
  fetchTtsChunks,
  getCachedVerifyConfig,
  getVerifyConfig,
  playBuffers,
  pickVariant,
  runExclusive,
  saveVerifyConfig,
  VERIFY_VOICES,
} from "../utils/verify.js";

/** Modal zum Auswählen mehrerer Rollen auf einmal. */
function buildRoleModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId("verify:roles:edit")
    .setTitle("Verify-Rollen")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Rollen")
        .setDescription("Eine oder mehrere Rollen auswählen.")
        .setRoleSelectMenuComponent(
          new RoleSelectMenuBuilder()
            .setCustomId("roles")
            .setMinValues(1)
            .setMaxValues(10)
            .setRequired(true),
        ),
    );
}

/** Anzeigename einer Stimme (ShortName → lesbares Label). */
function voiceLabel(name: string): string {
  return VERIFY_VOICES.find((v) => v.name === name)?.label ?? name;
}

const command: {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  modal: (interaction: ModalSubmitInteraction) => Promise<void>;
} = {
  data: new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Voice-Verify-System konfigurieren")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Zeigt die Verify-Einstellungen."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("channel")
        .setDescription("Setzt den Voice-Kanal für die Verifizierung.")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Der Verify-Voice-Kanal.")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("waiting")
            .setDescription("Setzt den Warteraum aus dem Mitglieder gezogen werden.")
        .addChannelOption((o) =>
          o
            .setName("channel")
            .setDescription("Der Warteraum-Voice-Kanal.")
            .addChannelTypes(ChannelType.GuildVoice)
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("Aktiviert oder deaktiviert das System.")
        .addBooleanOption((o) =>
          o.setName("enabled").setDescription("An oder aus.").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("message").setDescription("Setzt den vorzulesenden Text."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("speaknow")
        .setDescription("Setzt den Text mit dem das Sprechen freigeschaltet wird."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("voice")
        .setDescription("Wählt die TTS-Stimme.")
        .addStringOption((o) =>
          o
            .setName("voice")
            .setDescription("Die Stimme.")
            .setRequired(true)
            .addChoices(
              ...VERIFY_VOICES.map((v) => ({
                name: v.label,
                value: v.name,
              })),
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("join").setDescription("Verbinder den Bot mit dem Verify-Kanal."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("test")
        .setDescription("Spielt die aktuelle Ansage einmal ab (Test)."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("sprich")
        .setDescription("Spricht einen eigenen Text mit der aktuellen Stimme.")
        .addStringOption((o) =>
          o
            .setName("text")
            .setDescription("Der Text der gesprochen werden soll.")
            .setRequired(true),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("role")
        .setDescription("Verwaltet die zu vergebenden Rollen.")
        .addSubcommand((sub) =>
          sub
            .setName("select")
            .setDescription("Wählt mehrere Rollen auf einmal aus."),
        )
        .addSubcommand((sub) =>
          sub
            .setName("add")
            .setDescription("Fügt eine Rolle hinzu.")
            .addRoleOption((o) =>
              o.setName("role").setDescription("Die Rolle.").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("remove")
            .setDescription("Entfernt eine Rolle.")
            .addRoleOption((o) =>
              o.setName("role").setDescription("Die Rolle.").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("Zeigt alle Verify-Rollen."),
        ),
    ) as SlashCommandBuilder,
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    // Rechteprüfung zuerst – rein synchron, damit sofort geantwortet wird.
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({
        content: "Dieses Kommando funktioniert nur in einem Server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: "Du benötigst „Server verwalten“ um das Verify-System zu nutzen.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = guild.id;
    const sub = interaction.options.getSubcommand(true);
    const group = interaction.options.getSubcommandGroup(false);

    // Text setzen → Modal öffnen (showModal muss die erste Antwort sein).
    if (sub === "message") {
      const cfg = getCachedVerifyConfig(guildId);
      const modal = new ModalBuilder()
        .setCustomId("verify:message:edit")
        .setTitle("Verify-Ansage")
        .addLabelComponents(
          new LabelBuilder()
            .setLabel("Text")
            .setDescription("{user} wird durch den Namen ersetzt. Varianten trennst du mit ---.")
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId("message")
                .setStyle(TextInputStyle.Paragraph)
                .setValue(cfg.message.slice(0, 4000))
                .setPlaceholder("Hey {user} schön dass du da bist...")
                .setMinLength(1)
                .setMaxLength(4000)
                .setRequired(true),
            ),
        );
      await interaction.showModal(modal);
      return;
    }

    // Aufforderung zum Sprechen setzen → Modal öffnen.
    if (sub === "speaknow") {
      const cfg = getCachedVerifyConfig(guildId);
      const modal = new ModalBuilder()
        .setCustomId("speaknow")
        .setTitle("Sprech-Aufforderung")
        .addLabelComponents(
          new LabelBuilder()
            .setLabel("Text")
            .setDescription(
              "Wird gesprochen danach wird das Sprechrecht freigeschaltet. Varianten trennst du mit ---.",
            )
            .setTextInputComponent(
              new TextInputBuilder()
                .setCustomId("speaknow")
                .setStyle(TextInputStyle.Paragraph)
                .setValue(cfg.speakNowMessage.slice(0, 4000))
                .setPlaceholder("So {user} du bist dran...")
                .setMinLength(1)
                .setMaxLength(4000)
                .setRequired(true),
            ),
        );
      await interaction.showModal(modal);
      return;
    }

    // Mehrere Rollen auswählen → Modal öffnen (muss als Erstes kommen).
    if (group === "role" && sub === "select") {
      await interaction.showModal(buildRoleModal());
      return;
    }

    // Alle anderen Pfade lesen/schreiben Konfiguration → erst dehnen.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg = await getVerifyConfig(guildId);
    let message = "";

    try {
      if (sub === "status") {
        const roleMentions =
          cfg.roles.length > 0
            ? cfg.roles.map((id) => `<@&${id}>`).join(" ")
            : "Keine";
        message =
          `**Status:** ${cfg.enabled ? "Aktiviert" : "Deaktiviert"}\n` +
          `**Warteraum:** ${cfg.waitingChannelId ? `<#${cfg.waitingChannelId}>` : "Nicht gesetzt"}\n` +
          `**Kanal:** ${cfg.channelId ? `<#${cfg.channelId}>` : "Nicht gesetzt"}\n` +
          `**Stimme:** ${voiceLabel(cfg.voice)}\n` +
          `**Rollen:** ${roleMentions}\n` +
          `**Text:** ${cfg.message}\n` +
          `**Sprech-Aufforderung:** ${cfg.speakNowMessage}`;
      } else if (sub === "channel") {
        cfg.channelId = interaction.options.getChannel("channel", true).id;
        message = `Verify-Kanal: <#${cfg.channelId}>`;
      } else if (sub === "waiting") {
        cfg.waitingChannelId = interaction.options.getChannel("channel", true).id;
        message = `Warteraum: <#${cfg.waitingChannelId}>`;
      } else if (sub === "toggle") {
        cfg.enabled = interaction.options.getBoolean("enabled", true);
        message = cfg.enabled
          ? "Verify-System ist jetzt **aktiviert**."
          : "Verify-System ist jetzt **deaktiviert**.";
      } else if (sub === "voice") {
        cfg.voice = interaction.options.getString("voice", true);
        message = `Stimme gesetzt: ${voiceLabel(cfg.voice)}`;
      } else if (sub === "join") {
        if (!cfg.channelId) {
          await interaction.editReply({
            content: "Setze zuerst einen Kanal mit `/verify channel`.",
          });
          return;
        }
        const channel = guild.channels.cache.get(cfg.channelId);
        if (!channel?.isVoiceBased()) {
          await interaction.editReply({
            content: "Der konfigurierte Kanal ist kein Voice-Kanal.",
          });
          return;
        }
        if (!(await connectToVerifyChannel(guild, cfg.channelId))) {
          await interaction.editReply({
            content: "Verbindung fehlgeschlagen. Prüfe die Bot-Permissions.",
          });
          return;
        }
        message = `Bot ist im Kanal <#${cfg.channelId}> verbunden.`;
      } else if (sub === "test") {
        if (!cfg.channelId) {
          await interaction.editReply({
            content: "Setze zuerst einen Kanal mit `/verify channel`.",
          });
          return;
        }
        const channel = guild.channels.cache.get(cfg.channelId);
        if (!channel?.isVoiceBased()) {
          await interaction.editReply({
            content: "Der konfigurierte Kanal ist kein Voice-Kanal.",
          });
          return;
        }
        const connection = await connectToVerifyChannel(guild, cfg.channelId);
        if (!connection) {
          await interaction.editReply({
            content: "Verbindung fehlgeschlagen. Prüfe die Bot-Permissions.",
          });
          return;
        }
        const text = pickVariant(cfg.message).replace(
          /\{user\}/g,
          interaction.user.displayName,
        );
        let buffers: Buffer[];
        try {
          buffers = await fetchTtsChunks(text, cfg.voice);
        } catch (err) {
          logger.error("Verify-Test: TTS konnte nicht erzeugt werden.", {
            guildId,
            error: err,
          });
          await interaction.editReply({
            content: "Die Test-Ansage konnte nicht erzeugt werden. Prüfe die Logs.",
          });
          return;
        }
        await interaction.editReply({
          content: "Test-Ansage wird abgespielt – du solltest sie jetzt hören.",
        });
        // Läuft in derselben Warteschlange wie echte Verifizierungen.
        void runExclusive(guildId, () => playBuffers(connection, buffers));
        return;
      } else if (sub === "sprich") {
        if (!cfg.channelId) {
          await interaction.editReply({
            content: "Setze zuerst einen Kanal mit `/verify channel`.",
          });
          return;
        }
        const channel = guild.channels.cache.get(cfg.channelId);
        if (!channel?.isVoiceBased()) {
          await interaction.editReply({
            content: "Der konfigurierte Kanal ist kein Voice-Kanal.",
          });
          return;
        }
        const connection = await connectToVerifyChannel(guild, cfg.channelId);
        if (!connection) {
          await interaction.editReply({
            content: "Verbindung fehlgeschlagen. Prüfe die Bot-Permissions.",
          });
          return;
        }
        const text = interaction.options.getString("text", true);
        let buffers: Buffer[];
        try {
          buffers = await fetchTtsChunks(text, cfg.voice);
        } catch (err) {
          logger.error("Sprich-Test: TTS konnte nicht erzeugt werden.", {
            guildId,
            error: err,
          });
          await interaction.editReply({
            content: "Der Text konnte nicht erzeugt werden. Prüfe die Logs.",
          });
          return;
        }
        await interaction.editReply({
          content: `Spricht jetzt mit **${voiceLabel(cfg.voice)}**.`,
        });
        // Satzweise mit Pausen, genau wie die echten Ansagen - der Test soll
        // zeigen, was man danach auch wirklich hört.
        void runExclusive(guildId, () => playBuffers(connection, buffers));
        return;
      } else if (group === "role") {
        if (sub === "add") {
          const role = interaction.options.getRole("role", true);
          if (!cfg.roles.includes(role.id)) cfg.roles.push(role.id);
          message = `Rolle hinzugefügt: <@&${role.id}>`;
        } else if (sub === "remove") {
          const role = interaction.options.getRole("role", true);
          cfg.roles = cfg.roles.filter((id) => id !== role.id);
          message = `Rolle entfernt: <@&${role.id}>`;
        } else {
          message =
            cfg.roles.length > 0
              ? `Verify-Rollen:\n${cfg.roles.map((id) => `<@&${id}>`).join("\n")}`
              : "Keine Verify-Rollen konfiguriert.";
        }
      }

      await saveVerifyConfig(guildId, cfg);
      await interaction.editReply({
        content: message,
        allowedMentions: { parse: [] },
      });
    } catch (err) {
      logger.error("Fehler beim Konfigurieren des Verify-Systems.", {
        guildId,
        sub,
        error: err,
      });
      await interaction.editReply({
        content: "Beim Speichern ist ein unerwarteter Fehler aufgetreten.",
      });
    }
  },

  async modal(interaction: ModalSubmitInteraction): Promise<void> {
    if (!interaction.inGuild() || !interaction.guild) return;
    const guildId = interaction.guild.id;

    if (interaction.customId !== "verify:message:edit" &&
        interaction.customId !== "verify:roles:edit" &&
        interaction.customId !== "speaknow") return;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const cfg = await getVerifyConfig(guildId);

      if (interaction.customId === "verify:roles:edit") {
        const selected = interaction.fields.fields.has("roles")
          ? interaction.fields.getSelectedRoles("roles", true)
          : undefined;
        const ids = selected
          ? [...selected.values()].map((r) => r.id)
          : [];
        if (ids.length === 0) {
          await interaction.editReply({
            content: "Wähle mindestens eine Rolle aus.",
          });
          return;
        }
        cfg.roles = Array.from(new Set([...cfg.roles, ...ids]));
        await saveVerifyConfig(guildId, cfg);
        await interaction.editReply({
          content: `Verify-Rollen gesetzt:\n${ids.map((id) => `<@&${id}>`).join(" ")}`,
        });
        return;
      }

      if (interaction.customId === "speaknow") {
        const text = interaction.fields.getTextInputValue("speaknow")?.trim() ?? "";
        if (!text) {
          await interaction.editReply({
            content: "Der Text darf nicht leer sein.",
          });
          return;
        }
        cfg.speakNowMessage = text;
        await saveVerifyConfig(guildId, cfg);
        await interaction.editReply({
          content:
            "Sprech-Aufforderung gespeichert. Sie wird gesprochen danach " +
            "bekommt das Mitglied sein Sprechrecht.",
        });
        return;
      }

      const text = interaction.fields.getTextInputValue("message")?.trim() ?? "";
      if (!text) {
        await interaction.editReply({ content: "Der Text darf nicht leer sein." });
        return;
      }
      cfg.message = text;
      await saveVerifyConfig(guildId, cfg);
      await interaction.editReply({
        content: "Verify-Ansage gespeichert. Teste mit `/verify test`.",
      });
    } catch (err) {
      logger.error("Fehler beim Speichern der Verify-Einstellungen.", {
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
