import { Events } from "discord.js";
import { logger } from "../utils/logger.js";
import { getWelcomeConfig, buildWelcomeEmbed } from "../utils/welcome.js";
const event = {
    name: Events.GuildMemberAdd,
    async execute(member) {
        const guild = member.guild;
        const guildId = guild.id;
        if (member.user.bot)
            return;
        const cfg = await getWelcomeConfig(guildId);
        if (!cfg.enabled)
            return;
        for (const roleId of cfg.roleIds) {
            if (!roleId)
                continue;
            if (member.roles.cache.has(roleId))
                continue;
            let role = guild.roles.cache.get(roleId) ?? null;
            if (!role) {
                try {
                    role = await guild.roles.fetch(roleId);
                }
                catch (err) {
                    logger.warn("Konnte Rolle nicht laden.", { guildId, roleId, error: err });
                    continue;
                }
            }
            if (!role) {
                logger.warn("Rolle existiert nicht — wird übersprungen.", { guildId, roleId });
                continue;
            }
            try {
                await member.roles.add(roleId);
            }
            catch (err) {
                logger.warn("Rollenvergabe fehlgeschlagen.", { guildId, roleId, error: err });
            }
        }
        const embed = buildWelcomeEmbed(cfg, member.id);
        const targetChannel = cfg.channelId
            ? guild.channels.cache.get(cfg.channelId) ??
                (await guild.channels.fetch(cfg.channelId).catch(() => null))
            : null;
        if (targetChannel?.isTextBased() && "send" in targetChannel) {
            try {
                await targetChannel.send({
                    embeds: [embed],
                    allowedMentions: { parse: ["users"] },
                });
                return;
            }
            catch (err) {
                logger.warn("Konnte Willkommensnachricht nicht in Kanal senden.", {
                    guildId,
                    error: err,
                });
            }
        }
        try {
            await member.send({ embeds: [embed], allowedMentions: { parse: [] } });
            return;
        }
        catch (err) {
            logger.warn("Konnte Willkommensnachricht nicht per DM senden.", {
                guildId,
                error: err,
            });
        }
        try {
            const systemChannel = guild.systemChannel;
            if (systemChannel?.isTextBased() && "send" in systemChannel) {
                await systemChannel.send({
                    embeds: [embed],
                    allowedMentions: { parse: ["users"] },
                });
            }
        }
        catch (err) {
            logger.warn("Konnte Willkommensnachricht nicht in Systemkanal senden.", {
                guildId,
                error: err,
            });
        }
    },
};
export default event;
