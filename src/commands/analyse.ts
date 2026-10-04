import {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { logger } from "../utils/logger.js";
import type { BotCommand } from "./index.js";
import {
  keysStore,
  renderKeyMessage,
  issueKey,
  revokeKey,
  findEntriesByTarget,
  findEntryByKey,
  APPROVE_EMOJI,
} from "../utils/analysisKeys.js";

const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("analyse")
    .setDescription("Sende Analyse-Keys an Analysten und verwalte deren Status.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub
        .setName("send")
        .setDescription("Sendet einen vorgegebenen Analyse-Key per DM an einen User.")
        .addUserOption((o) =>
          o
            .setName("user")
            .setDescription("Der Analyst, der den Key erhält.")
            .setRequired(true),
        )
        .addStringOption((o) =>
          o
            .setName("key")
            .setDescription("Der zuzuweisende Analyse-Key.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("status")
        .setDescription("Zeigt die vergebenen Keys eines Users an.")
        .addUserOption((o) =>
          o
            .setName("user")
            .setDescription("Der Analyst, dessen Keys angezeigt werden.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("revoke")
        .setDescription("Setzt einen Key als widerrufen.")
        .addStringOption((o) =>
          o
            .setName("key")
            .setDescription("Der Key, der widerrufen werden soll.")
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("Zeigt die letzten Key-Zuweisungen an."),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content:
          "Du benötigst die Berechtigung „Server verwalten“, um Keys zu vergeben.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand(true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      if (sub === "send") {
        const user = interaction.options.getUser("user", true);
        const key = interaction.options.getString("key", true).trim();

        if (!key) {
          await interaction.editReply("Der Key darf nicht leer sein.");
          return;
        }

        const existing = await findEntryByKey(key);
        if (existing) {
          const state = existing.consumed
            ? "und bereits verbraucht"
            : existing.revoked
              ? "und widerrufen"
              : "(noch offen)";
          await interaction.editReply(
            `Der Key \`${key}\` wurde bereits vergeben ${state}. Nutze einen anderen Key.`,
          );
          return;
        }

        const dm = await user.createDM();
        const sent = await dm.send(renderKeyMessage(key));
        await issueKey({
          messageId: sent.id,
          channelId: dm.id,
          guildId: interaction.guildId ?? undefined,
          targetUserId: user.id,
          issuedById: interaction.user.id,
          key,
        });

        logger.info("Analytics key issued.", { targetUserId: user.id, key });

        await interaction.editReply(
          `✅ Key \`${key}\` wurde per DM an <@${user.id}> gesendet.\n` +
            `Sobald der Analyst mit ${APPROVE_EMOJI} auf die Nachricht reagiert, wird der Key automatisch als **VERBRAUCHT** markiert.\n\n` +
            ``,
        );
        return;
      }

      if (sub === "status") {
        const user = interaction.options.getUser("user", true);
        const entries = await findEntriesByTarget(user.id);

        if (entries.length === 0) {
          await interaction.editReply(
            `Für <@${user.id}> wurden noch keine Keys vergeben.`,
          );
          return;
        }

        const lines = entries.map((e) => {
          const state = e.revoked
            ? "🚫 Widerrufen"
            : e.consumed
              ? "✅ Verbraucht"
              : "🕐 Offen";
          return `\`${e.key}\` — ${state}`;
        });

        await interaction.editReply(
          `**Key-Status für <@${user.id}>**\n${lines.join("\n")}\n\n`,
        );
        return;
      }

      if (sub === "revoke") {
        const key = interaction.options.getString("key", true).trim();
        const entry = await revokeKey(key);

        if (!entry) {
          await interaction.editReply(
            `Kein Key \`${key}\` in der Datenbank gefunden.`,
          );
          return;
        }

        try {
          const channel = await interaction.client.channels
            .fetch(entry.channelId)
            .catch(() => null);
          if (channel?.isTextBased() && "messages" in channel) {
            const msg = await channel.messages
              .fetch(entry.messageId)
              .catch(() => null);
            if (msg) {
              await msg.edit(
                "# 🚫 KEY WIDERRUFEN\n\nDieser Key ist nicht mehr gültig.\n\n",
              );
            }
          }
        } catch (err) {
          logger.warn("Could not update revoked key message.", {
            key,
            error: err,
          });
        }

        await interaction.editReply(
          `🚫 Key \`${key}\` wurde als **widerrufen** markiert.`,
        );
        return;
      }

      // list
      const data = await keysStore.read();
      const last = [...(data.keys ?? [])].slice(-10).reverse();
      if (last.length === 0) {
        await interaction.editReply("Es wurden noch keine Keys vergeben.");
        return;
      }
      const lines = last.map((e) => {
        const state = e.revoked ? "🚫" : e.consumed ? "✅" : "🕐";
        return `${state} \`${e.key}\` → <@${e.targetUserId}>`;
      });
      await interaction.editReply(
        `**Letzte Key-Zuweisungen**\n${lines.join("\n")}\n\n`,
      );
    } catch (err) {
      logger.error("Error in /analyse.", { error: err });
      try {
        await interaction.editReply(
          "Beim Ausführen ist ein Fehler aufgetreten (z. B. konnte der User nicht per DM erreicht werden). Prüfe die Logs.",
        );
      } catch {
        /* interaction may no longer be valid */
      }
    }
  },
};

export default command;
