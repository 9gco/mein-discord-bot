import { Events, } from "discord.js";
import { logger } from "../utils/logger.js";
import { APPROVE_EMOJI, findEntryByMessageId, consumeKey, } from "../utils/analysisKeys.js";
async function resolveUser(user) {
    return user.partial ? user.fetch().catch(() => null) : user;
}
const event = {
    name: Events.MessageReactionAdd,
    async execute(reaction, user) {
        if (user.bot)
            return;
        if (reaction.emoji.name !== APPROVE_EMOJI)
            return;
        const resolvedUser = await resolveUser(user);
        if (!resolvedUser)
            return;
        const entry = await findEntryByMessageId(reaction.message.id);
        if (!entry)
            return;
        if (entry.consumed || entry.revoked)
            return;
        if (resolvedUser.id !== entry.targetUserId)
            return;
        const consumed = await consumeKey(entry.messageId, Date.now());
        if (!consumed)
            return;
        logger.info("Analytics key consumed.", {
            key: consumed.key,
            targetUserId: consumed.targetUserId,
        });
        try {
            if (reaction.message.partial) {
                await reaction.message.fetch();
            }
            const current = reaction.message.content ?? "";
            await reaction.message.edit(current +
                "\n\n✅ **Key verbraucht.** (" +
                new Date().toLocaleString("de-DE") +
                ")\n*Built with VybeBot.ai*");
        }
        catch (err) {
            logger.warn("Could not update consumed key message.", {
                key: consumed.key,
                error: err,
            });
        }
    },
};
export default event;
