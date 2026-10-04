import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig } from "../config.js";
import { logger } from "./logger.js";

/**
 * A namespaced key/value store — one JSON file per key.
 *
 * The shape matches what most storage plugins expect, so swapping the file
 * backend for Redis or Postgres later touches only this file.
 */
export interface KeyValueStore<T> {
  read(key: string): Promise<T | undefined>;
  write(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * File-backed storage, one JSON file per key.
 *
 * On VybeBot Cloud with persistent storage enabled the root directory is
 * `PERSISTENT_DATA_DIR` (`/app/data`), a Docker volume that survives
 * redeployments and host migrations. Without it the bot falls back to `.data`
 * in the working directory, which is wiped on every redeploy — fine for local
 * development, not for anything users expect to keep.
 */
class FileStore<T> implements KeyValueStore<T> {
  private readonly ready: Promise<void>;

  constructor(private readonly directory: string) {
    this.ready = mkdir(directory, { recursive: true }).then(
      () => undefined,
      (err: unknown) => {
        logger.error(
          "Could not create the storage directory — data will not persist.",
          {
            directory,
            error: err,
          },
        );
      },
    );
  }

  private path(key: string): string {
    // Keys come from guild/channel/user IDs, but never trust them with the
    // filesystem.
    return join(this.directory, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  async read(key: string): Promise<T | undefined> {
    await this.ready;
    try {
      return JSON.parse(await readFile(this.path(key), "utf-8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      logger.error("Failed to read stored value.", { key, error: err });
      return undefined;
    }
  }

  async write(key: string, value: T): Promise<void> {
    await this.ready;
    const target = this.path(key);
    // Write-then-rename so a crash or a redeploy mid-write cannot truncate
    // existing data.
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value), "utf-8");
    await rename(temporary, target);
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    await rm(this.path(key), { force: true });
  }

  async keys(): Promise<string[]> {
    await this.ready;
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5));
  }
}

/**
 * Returns the storage for one namespace ("guilds", "tickets", …).
 *
 * Use this for state keyed by a Discord ID — per-guild settings, per-user
 * preferences, the details behind a short `customId`.
 */
export function createStorage<T>(
  config: BotConfig,
  namespace: string,
): KeyValueStore<T> {
  return new FileStore<T>(join(config.storage.dir, namespace));
}

/** Absolute path for a bot's own data files, e.g. an SQLite database. */
export function dataPath(config: BotConfig, ...segments: string[]): string {
  return join(config.storage.dir, ...segments);
}

/**
 * One JSON document on disk — the storage a feature usually wants: a list of
 * FAQ entries, a config object, a set of scheduled jobs.
 *
 * Loaded once and cached, saved atomically after every mutation, and shared
 * per file so two modules asking for the same document get the same instance.
 */
export interface JsonStore<T> {
  /** The document, read from disk on first use and cached afterwards. */
  read(): Promise<T>;
  /** Replaces the whole document. */
  write(value: T): Promise<void>;
  /**
   * Reads, lets you mutate in place, then saves. Whatever the callback returns
   * is returned to you:
   *
   * ```ts
   * const entry = await faq.update((data) => {
   *   const created = { id: newId(), question, answer };
   *   data.entries.push(created);
   *   return created;
   * });
   * ```
   */
  update<R>(mutate: (data: T) => R | Promise<R>): Promise<R>;
  /** Path of the backing file, for logging. */
  readonly file: string;
}

const jsonStores = new Map<string, JsonStore<unknown>>();

/**
 * Returns the JSON document stored at `<data dir>/<name>`, creating it from
 * `initial` the first time.
 *
 * Use this instead of touching `node:fs` — it already handles the directory,
 * atomic writes, caching, and a corrupt file (which is set aside rather than
 * silently discarded, so nothing is lost when a deploy interrupts a write).
 *
 * Suited to documents that comfortably fit in memory. For state keyed by a
 * Discord ID use `createStorage`; for anything you need to query or that grows
 * without bound, use a database.
 */
export function createJsonStore<T>(
  config: BotConfig,
  name: string,
  initial: T,
): JsonStore<T> {
  const file = dataPath(config, name);

  const existing = jsonStores.get(file);
  if (existing) return existing as JsonStore<T>;

  let cache: T | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function loadFromDisk(): Promise<T> {
    try {
      return JSON.parse(await readFile(file, "utf-8")) as T;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return structuredClone(initial);

      // Unreadable or invalid JSON: keep the file for inspection instead of
      // overwriting it on the next save, and carry on with a fresh document.
      const backup = `${file}.corrupt-${Date.now()}`;
      await rename(file, backup).catch(() => undefined);
      logger.error("Stored document was unreadable — starting fresh.", {
        file,
        backup,
        error: err,
      });
      return structuredClone(initial);
    }
  }

  async function save(value: T): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2), "utf-8");
    await rename(temporary, file);
  }

  /** Serialises writes so two updates cannot rename over each other. */
  function enqueue<R>(task: () => Promise<R>): Promise<R> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
  }

  const store: JsonStore<T> = {
    file,

    async read(): Promise<T> {
      cache ??= await loadFromDisk();
      return cache;
    },

    write(value: T): Promise<void> {
      cache = value;
      return enqueue(() => save(value));
    },

    async update<R>(mutate: (data: T) => R | Promise<R>): Promise<R> {
      const data = await store.read();
      const result = await mutate(data);
      await enqueue(() => save(data));
      return result;
    },
  };

  jsonStores.set(file, store as JsonStore<unknown>);
  return store;
}
