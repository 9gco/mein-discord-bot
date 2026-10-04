import {
  Events,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from "discord.js";
import { logger } from "../utils/logger.js";
import type { BotEvent } from "./index.js";
import {
  APPROVE_EMOJI,
  findEntryByMessageId,
  consumeKey,
} from "../utils/analysisKeys.js";

async function resolveUser(user: User | PartialUser): Promise<User | null> {
  return user.partial ? user.fetch().catch(() => null) : user;
}

const event: BotEvent<Events.MessageReactionAdd> = {
  name: Events.MessageReactionAdd,

  async execute(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    // Nur echte Nutzer, keine Bot-Reaktionen.
    if (user.bot) return;

    // Nur die Bestätigungs-Reaktion zählt.
    if (reaction.emoji.name !== APPROVE_EMOJI) return;

    const resolvedUser = await resolveUser(user);
    if (!resolvedUser) return;

    const entry = await findEntryByMessageId(reaction.message.id);
    if (!entry) return; // keine Key-Zuweisung für diese Nachricht
    if (entry.consumed || entry.revoked) return;

    // Nur der zugewiesene Analyst darf den Key verbrauchen.
    if (resolvedUser.id !== entry.targetUserId) return;

    const consumed = await consumeKey(entry.messageId, Date.now());
    if (!consumed) return;

    logger.info("Analytics key consumed.", {
      key: consumed.key,
      targetUserId: consumed.targetUserId,
    });

    // DM-Nachricht aktualisieren, damit der Status sichtbar ist.
    try {
      if (reaction.message.partial) {
        await reaction.message.fetch();
      }
      const current = reaction.message.content ?? "";
      await reaction.message.edit(
        current +
          "\n\n✅ **Key verbraucht.** (" +
          new Date().toLocaleString("de-DE") +
          ")\n",
      );
    } catch (err) {
      logger.warn("Could not update consumed key message.", {
        key: consumed.key,
        error: err,
      });
    }
  },
};

export default event;
