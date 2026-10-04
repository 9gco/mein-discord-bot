import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { BotCommand } from "./index.js";

const command: BotCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription(
      "Replies with Pong and the bot's current latency.",
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const sent = await interaction.reply({
      content: "Pinging…",
      withResponse: true,
    });
    const latency =
      sent.resource?.message?.createdTimestamp! - interaction.createdTimestamp;
    await interaction.editReply(`Pong! 🏓  Round-trip: **${latency}ms**`);
  },
};

export default command;
