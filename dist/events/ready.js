import { Events } from "discord.js";
import { loadConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import { connectToVerifyChannel, getVerifyConfig, } from "../utils/verify.js";
async function autoJoinVerifyChannels(client) {
    for (const guild of client.guilds.cache.values()) {
        try {
            const cfg = await getVerifyConfig(guild.id);
            if (!cfg.enabled || !cfg.channelId)
                continue;
            const channel = guild.channels.cache.get(cfg.channelId);
            if (!channel?.isVoiceBased())
                continue;
            connectToVerifyChannel(guild, cfg.channelId);
            logger.info("Mit dem Verify-Kanal verbunden.", {
                guildId: guild.id,
                channelId: cfg.channelId,
            });
        }
        catch (err) {
            logger.error("Auto-Join in den Verify-Kanal fehlgeschlagen.", {
                guildId: guild.id,
                error: err,
            });
        }
    }
}
const event = {
    name: Events.ClientReady,
    once: true,
    async execute(client) {
        const { storage } = loadConfig();
        client.user.setActivity("Built with VybeBot.ai");
        logger.info("Bot is online.", {
            tag: client.user.tag,
            dataDir: storage.dir,
            durableStorage: storage.durable,
        });
        setImmediate(() => void autoJoinVerifyChannels(client));
    },
};
export default event;
