import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../utils/logger.js";
import type { BotCommand } from "./index.js";
import { generateKey, validateKey, findKeyDetails } from "../utils/analysisKeys.js";

const PIN_ROLE_ID = "1547675275226120252";

const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("pin")
    .setDescription(
      "Generiert und prüft FivemScanner Lizenz-Keys (Pins) über den Key-Server.",
    )
    .addSubcommand((sub) =>
      sub
        .setName("generieren")
        .setDescription("Erzeugt einen neuen Lizenz-Key auf dem Key-Server.")
        .addIntegerOption((o) =>
          o
            .setName("tage")
            .setDescription("Laufzeit in Tagen (Standard: 30, 0 = nie abläuft).")
            .setMinValue(0)
            .setMaxValue(3650)
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName("plan")
            .setDescription("Key-Plan (Standard: standard).")
            .setRequired(false),
        )
        .addStringOption((o) =>
          o
            .setName("notiz")
            .setDescription("Optionale Notiz für den Key.")
            .setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("anzeigen")
        .setDescription("Zeigt Details zu einem Key über die Admin-API an.")
        .addStringOption((o) =>
          o
            .setName("key")
            .setDescription("Der zu prüfende Lizenz-Key / Pin.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("check")
        .setDescription("Validiert einen Key öffentlich (ohne Admin-Rechte auf dem Server).")
        .addStringOption((o) =>
          o
            .setName("key")
            .setDescription("Der zu prüfende Lizenz-Key / Pin.")
            .setRequired(true),
        ),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const member = interaction.guild?.members.cache.get(interaction.user.id);
    if (!member || !member.roles.cache.has(PIN_ROLE_ID)) {
      await interaction.reply({
        content: `Du benötigst die Rolle <@&${PIN_ROLE_ID}> um Pins zu verwalten.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand(true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (sub === "generieren") {
        const days = interaction.options.getInteger("tage") ?? 30;
        const plan = interaction.options.getString("plan") ?? "standard";
        const note =
          interaction.options.getString("notiz") ??
          `Generiert von <@${interaction.user.id}> via Discord`;

        const generated = await generateKey(days, plan, note);

        if (!generated) {
          await interaction.editReply(
            "❌ Der Pin konnte nicht generiert werden. Prüfe ob `GAMMA_API_KEY` gesetzt ist und der Key-Server erreichbar ist. Siehe Logs.",
          );
          return;
        }

        const expires = generated.expiresAt
          ? new Date(generated.expiresAt).toLocaleString("de-DE")
          : "nie";

        await interaction.editReply(
          `✅ **Pin generiert**\n` +
            `🔑 \`${generated.key}\`\n` +
            `📦 Plan: **${generated.plan}**\n` +
            `⏳ Laufzeit: bis **${expires}**\n` +
            `📝 Notiz: ${note}\n\n` +
            `Verteile den Pin mit \`/analyse send\` an einen Analysten.`,
        );
        return;
      }

      if (sub === "anzeigen") {
        const key = interaction.options.getString("key", true).trim();
        const details = await findKeyDetails(key);
        if (!details) {
          await interaction.editReply(
            "❌ Pin nicht gefunden oder Admin-Token (`GAMMA_API_KEY`) nicht gesetzt. Siehe Logs.",
          );
          return;
        }

        const exp = details.expiresAt
          ? new Date(details.expiresAt).toLocaleString("de-DE")
          : "nie";
        const created = new Date(details.createdAt).toLocaleString("de-DE");
        const lastUsed = details.lastUsedAt
          ? new Date(details.lastUsedAt).toLocaleString("de-DE")
          : "nie";

        await interaction.editReply(
          `🔑 **Pin-Details**\n` +
            `Pin: \`${details.key}\`\n` +
            `Plan: **${details.plan}**\n` +
            `Status: ${details.revoked ? "🚫 widerrufen" : "✅ aktiv"}\n` +
            `Erstellt: **${created}**\n` +
            `Läuft ab: **${exp}**\n` +
            `Nutzungen: **${details.uses}**\n` +
            `Zuletzt benutzt: **${lastUsed}**\n` +
            `Notiz: ${details.note ?? "—"}`,
        );
        return;
      }

      if (sub === "check") {
        const key = interaction.options.getString("key", true).trim();
        const result = await validateKey(key);
        if (!result) {
          await interaction.editReply(
            "❌ Die Validierung konnte nicht durchgeführt werden. Prüfe die Logs.",
          );
          return;
        }

        if (result.valid) {
          const exp = result.expiresAt
            ? new Date(result.expiresAt).toLocaleString("de-DE")
            : "nie";
          await interaction.editReply(
            `✅ **Pin gültig**\n` +
              `🔑 \`${key}\`\n` +
              `📦 Plan: **${result.plan ?? "standard"}**\n` +
              `⏳ Laufzeit: bis **${exp}**\n` +
              `🔢 Nutzungen: ${result.uses ?? "—"}`,
          );
        } else {
          await interaction.editReply(
            `❌ **Pin ungültig**\n` +
              `🔑 \`${key}\`\n` +
              `📋 Grund: ${result.reason ?? "unbekannt"}`,
          );
        }
        return;
      }
    } catch (err) {
      logger.error("Error in /pin.", { error: err, sub });
      try {
        await interaction.editReply("Beim Abruf ist ein Fehler aufgetreten. Prüfe die Logs.");
      } catch {
        /* interaction may no longer be valid */
      }
    }
  },
};

export default command;
