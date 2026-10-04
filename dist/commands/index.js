import { Collection, } from "discord.js";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../utils/logger.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
export async function loadCommands() {
    const commands = new Collection();
    const files = readdirSync(__dirname).filter((f) => (f.endsWith(".js") || f.endsWith(".ts")) &&
        f !== "index.js" &&
        f !== "index.ts");
    for (const file of files) {
        const filePath = join(__dirname, file);
        const module = await import(pathToFileURL(filePath).href);
        if (!module.default) {
            logger.warn("Command file is missing a default export — skipping.", {
                file,
            });
            continue;
        }
        const command = module.default;
        commands.set(command.data.name, command);
        logger.info("Loaded command.", { name: command.data.name });
    }
    return commands;
}
