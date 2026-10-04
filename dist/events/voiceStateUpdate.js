import { Events } from "discord.js";
import { logger } from "../utils/logger.js";
import { connectToVerifyChannel, fetchTtsAudio, getVerifyConfig, playBuffer, runExclusive, } from "../utils/verify.js";
const pending = new Set();
async function verifyMember(guild, member, cfg) {
    const channelId = cfg.channelId;
    if (!channelId)
        return;
    if (member.voice.channelId !== channelId) {
        logger.info("Nutzer hat den Verify-Kanal verlassen – überspringe.", {
            guildId: guild.id,
            userId: member.id,
        });
        return;
    }
    const connection = await connectToVerifyChannel(guild, channelId);
    if (!connection) {
        logger.error("Konnte keine Voice-Verbindung zum Verify-Kanal herstellen.", {
            guildId: guild.id,
            channelId,
        });
    }
    else {
        try {
            const text = cfg.message.replace(/\{user\}/g, member.displayName);
            const buffer = await fetchTtsAudio(text, cfg.voice);
            await playBuffer(connection, buffer);
        }
        catch (err) {
            logger.error("TTS-Ansage konnte nicht abgespielt werden.", {
                guildId: guild.id,
                userId: member.id,
                error: err,
            });
        }
    }
    const rolesToAdd = cfg.roles.filter((roleId) => !member.roles.cache.has(roleId));
    if (rolesToAdd.length > 0) {
        try {
            await member.roles.add(rolesToAdd, "Automatische TTS-Verifizierung");
        }
        catch (err) {
            logger.error("Verify-Rollen konnten nicht vergeben werden.", {
                guildId: guild.id,
                userId: member.id,
                roleIds: rolesToAdd,
                error: err,
            });
        }
    }
    if (member.voice.channelId) {
        await member.voice.setChannel(null).catch(() => undefined);
    }
}
const event = {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState) {
        const guild = newState.guild;
        if (!guild)
            return;
        if (newState.member?.user.bot)
            return;
        if (!newState.channelId)
            return;
        if (oldState.channelId === newState.channelId)
            return;
        const cfg = await getVerifyConfig(guild.id);
        if (!cfg.enabled)
            return;
        if (!cfg.channelId)
            return;
        if (newState.channelId !== cfg.channelId)
            return;
        const member = newState.member;
        if (!member)
            return;
        if (cfg.roles.some((roleId) => member.roles.cache.has(roleId)))
            return;
        if (pending.has(member.id))
            return;
        pending.add(member.id);
        void runExclusive(guild.id, async () => {
            try {
                await verifyMember(guild, member, cfg);
            }
            finally {
                pending.delete(member.id);
            }
        });
    },
};
export default event;
