import { SlashCommandBuilder, } from "discord.js";
const command = {
    data: new SlashCommandBuilder()
        .setName("ping")
        .setDescription("Replies with Pong and the bot's current latency."),
    async execute(interaction) {
        const sent = await interaction.reply({
            content: "Pinging…",
            withResponse: true,
        });
        const latency = sent.resource?.message?.createdTimestamp - interaction.createdTimestamp;
        await interaction.editReply(`Pong! 🏓  Round-trip: **${latency}ms**`);
    },
};
export default command;
