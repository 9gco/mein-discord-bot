import { REST, Routes } from "discord.js";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "./utils/logger.js";
import { describeDeployFailure } from "./utils/errors.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
export async function deployCommands(config) {
    const rest = new REST().setToken(config.token);
    const commandDir = join(__dirname, "commands");
    const files = readdirSync(commandDir).filter((f) => (f.endsWith(".js") || f.endsWith(".ts")) &&
        f !== "index.js" &&
        f !== "index.ts");
    const commandData = [];
    for (const file of files) {
        const filePath = join(commandDir, file);
        const module = await import(pathToFileURL(filePath).href);
        if (module.default?.data) {
            commandData.push(module.default.data.toJSON());
        }
    }
    try {
        if (config.guildId) {
            logger.info("Deploying commands to guild.", {
                guildId: config.guildId,
                count: commandData.length,
            });
            await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commandData });
            logger.info("Guild commands deployed successfully.");
        }
        else {
            logger.info("Deploying commands globally.", { count: commandData.length });
            await rest.put(Routes.applicationCommands(config.clientId), { body: commandData });
            logger.info("Global commands deployed successfully.");
        }
    }
    catch (err) {
        throw describeDeployFailure(err, config.clientId);
    }
}
