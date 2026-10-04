import { mkdir } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { deployCommands } from "./deploy-commands.js";
import { loadCommands } from "./commands/index.js";
import { loadEvents } from "./events/index.js";
import { logger } from "./utils/logger.js";
import { BotClient, setClient } from "./bot/client.js";
import { StartupError, describeLoginFailure } from "./utils/errors.js";

async function main(): Promise<void> {
  const config = loadConfig();

  await mkdir(config.storage.dir, { recursive: true });
  if (!config.storage.durable) {
    logger.warn(
      "PERSISTENT_DATA_DIR is not set — storing data locally, which is lost on redeploy. " +
        "Enable persistent storage for this branch to keep it.",
      { dir: config.storage.dir },
    );
  }

  await deployCommands(config);

  const client = new BotClient();
  setClient(client);
  const commands = await loadCommands();
  commands.forEach((cmd, name) => client.commands.set(name, cmd));

  await loadEvents(client);

  try {
    await client.login(config.token);
  } catch (err: unknown) {
    throw describeLoginFailure(err);
  }
}

main().catch((err: unknown) => {
  if (err instanceof StartupError) {
    // The message already says what to fix — a stack trace would only bury it.
    logger.error(err.message);
  } else {
    logger.error(err instanceof Error ? err : String(err));
  }
  process.exit(1);
});
