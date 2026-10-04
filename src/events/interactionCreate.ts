import { Events, MessageFlags, type Interaction } from "discord.js";
import { logger } from "../utils/logger.js";
import type { BotEvent } from "./index.js";
import type { BotCommand } from "../commands/index.js";

function isInteractionExpiredOrAcknowledged(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    return (
      code === 10062 ||
      code === 40060 ||
      code === "InteractionAlreadyReplied"
    );
  }
  return false;
}

function getActionableHint(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const errorObj = err as Record<string, any>;
  const code = errorObj.code;
  const message = String(errorObj.message || "");

  if (code === 10062) {
    return "Interaction token expired (> 3s). Call deferReply() or deferUpdate() at the very start of the handler.";
  }
  if (code === 40060 || code === "InteractionAlreadyReplied") {
    return "Interaction was already acknowledged. Use followUp() or editReply(), and ensure showModal() is called first without prior deferral.";
  }
  if (message.includes("MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2")) {
    return "Cannot send 'content' on a message with MessageFlags.IsComponentsV2. When updating a V2 message, wrap text in ContainerBuilder + TextDisplayBuilder, or open a Modal.";
  }
  if (message.includes("COMPONENT_REQUIRED_ZERO_MIN_VALUES")) {
    return "A required component cannot have min_values: 0. Add setRequired(false) or increase min_values to 1.";
  }
  if (message.includes("Invalid protocol for media URL")) {
    return "Media URL must be http:, https:, or attachment:. Never pass empty strings (\"\") or data: URIs to ThumbnailBuilder or FileBuilder.";
  }
  if (message.includes("ModalSubmitInteractionFieldNotFound")) {
    return "Modal field not found. In discord.js 14.27.0, check interaction.fields.fields.has(customId) before calling get*() on optional fields, and place customId on the inner component rather than LabelBuilder.";
  }
  return undefined;
}

async function replyWithError(interaction: any): Promise<void> {
  if (!interaction.isRepliable?.()) return;
  const reply = {
    content: "An unexpected error occurred. Please check the bot logs for details.",
    flags: MessageFlags.Ephemeral,
  };
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  } catch (error: unknown) {
    if (!isInteractionExpiredOrAcknowledged(error)) {
      logger.warn("Could not send interaction error response.", { error });
    }
  }
}

const event: BotEvent<Events.InteractionCreate> = {
  name: Events.InteractionCreate,

  async execute(interaction: Interaction): Promise<void> {
    // 1. Chat input (Slash command)
    if (interaction.isChatInputCommand()) {
      const commandName = interaction.commandName;
      const command = interaction.client.commands.get(commandName) as
        BotCommand | undefined;
      if (!command) {
        logger.warn("Received unknown command.", { name: commandName });
        await interaction.reply({
          content: "Unknown command.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      try {
        await command.execute(interaction);
      } catch (err) {
        const hint = getActionableHint(err);
        logger.error("Error executing command.", {
          name: commandName,
          error: err,
          ...(hint ? { hint } : {}),
        });
        if (!isInteractionExpiredOrAcknowledged(err)) {
          await replyWithError(interaction);
        }
      }
      return;
    }

    // 2. Autocomplete
    if (interaction.isAutocomplete()) {
      const commandName = interaction.commandName;
      const command = interaction.client.commands.get(commandName) as
        BotCommand | undefined;
      if (!command || !command.autocomplete) return;

      try {
        await command.autocomplete(interaction);
      } catch (err) {
        logger.error("Error executing autocomplete.", {
          name: commandName,
          error: err,
        });
      }
      return;
    }

    // 3. Components & Modals (routed via customId matching)
    let customId = "";
    if (
      interaction.isButton() ||
      interaction.isAnySelectMenu() ||
      interaction.isModalSubmit()
    ) {
      customId = interaction.customId;
    }

    if (customId) {
      // Find matching command by command name prefix
      let matchedCommand: BotCommand | undefined;
      let matchedCommandName = "";

      for (const [name, cmd] of interaction.client.commands.entries()) {
        if (
          customId === name ||
          customId.startsWith(`${name}:`) ||
          customId.startsWith(`${name}-`) ||
          customId.startsWith(`${name}_`) ||
          customId.startsWith(`${name}/`)
        ) {
          matchedCommand = cmd as BotCommand;
          matchedCommandName = name;
          break;
        }
      }

      if (matchedCommand) {
        try {
          if (interaction.isButton() && matchedCommand.button) {
            await matchedCommand.button(interaction);
          } else if (
            interaction.isStringSelectMenu() &&
            matchedCommand.stringSelectMenu
          ) {
            await matchedCommand.stringSelectMenu(interaction);
          } else if (
            interaction.isUserSelectMenu() &&
            matchedCommand.userSelectMenu
          ) {
            await matchedCommand.userSelectMenu(interaction);
          } else if (
            interaction.isRoleSelectMenu() &&
            matchedCommand.roleSelectMenu
          ) {
            await matchedCommand.roleSelectMenu(interaction);
          } else if (
            interaction.isMentionableSelectMenu() &&
            matchedCommand.mentionableSelectMenu
          ) {
            await matchedCommand.mentionableSelectMenu(interaction);
          } else if (
            interaction.isChannelSelectMenu() &&
            matchedCommand.channelSelectMenu
          ) {
            await matchedCommand.channelSelectMenu(interaction);
          } else if (interaction.isModalSubmit() && matchedCommand.modal) {
            await matchedCommand.modal(interaction);
          }
        } catch (err) {
          const hint = getActionableHint(err);
          logger.error("Error executing component/modal interaction.", {
            command: matchedCommandName,
            customId,
            error: err,
            ...(hint ? { hint } : {}),
          });
          if (interaction.isRepliable() && !isInteractionExpiredOrAcknowledged(err)) {
            await replyWithError(interaction);
          }
        }
      }
    }
  },
};

export default event;
