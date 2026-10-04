import {
  Collection,
  type ChatInputCommandInteraction,
  type SlashCommandBuilder,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
  type RoleSelectMenuInteraction,
  type MentionableSelectMenuInteraction,
  type ChannelSelectMenuInteraction,
} from "discord.js";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../utils/logger.js";

export interface BotCommand {
  data: SlashCommandBuilder;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<void>;
  button?: (interaction: ButtonInteraction) => Promise<void>;
  stringSelectMenu?: (
    interaction: StringSelectMenuInteraction,
  ) => Promise<void>;
  userSelectMenu?: (interaction: UserSelectMenuInteraction) => Promise<void>;
  roleSelectMenu?: (interaction: RoleSelectMenuInteraction) => Promise<void>;
  mentionableSelectMenu?: (
    interaction: MentionableSelectMenuInteraction,
  ) => Promise<void>;
  channelSelectMenu?: (
    interaction: ChannelSelectMenuInteraction,
  ) => Promise<void>;
  modal?: (interaction: ModalSubmitInteraction) => Promise<void>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadCommands(): Promise<Collection<string, BotCommand>> {
  const commands = new Collection<string, BotCommand>();

  const files = readdirSync(__dirname).filter(
    (f) =>
      (f.endsWith(".js") || f.endsWith(".ts")) &&
      f !== "index.js" &&
      f !== "index.ts",
  );

  for (const file of files) {
    const filePath = join(__dirname, file);
    const module = await import(pathToFileURL(filePath).href);

    if (!module.default) {
      logger.warn("Command file is missing a default export — skipping.", {
        file,
      });
      continue;
    }

    const command = module.default as BotCommand;
    commands.set(command.data.name, command);
    logger.info("Loaded command.", { name: command.data.name });
  }

  return commands;
}
