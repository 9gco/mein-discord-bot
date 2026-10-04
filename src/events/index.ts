import type { Client, ClientEvents } from "discord.js";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logger } from "../utils/logger.js";

export interface BotEvent<K extends keyof ClientEvents = keyof ClientEvents> {
  name: K;
  once?: boolean;
  execute: (...args: ClientEvents[K]) => void | Promise<void>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function loadEvents(client: Client): Promise<void> {
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
      logger.warn("Event file is missing a default export — skipping.", {
        file,
      });
      continue;
    }

    const event = module.default as BotEvent<any>;

    if (event.once) {
      client.once(event.name, (...args: any[]) => void event.execute(...args));
    } else {
      client.on(event.name, (...args: any[]) => void event.execute(...args));
    }

    logger.info("Registered event listener.", {
      name: event.name,
      once: event.once ?? false,
    });
  }
}
