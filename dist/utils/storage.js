import { mkdir, readdir, readFile, rename, rm, writeFile, } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "./logger.js";
class FileStore {
    directory;
    ready;
    constructor(directory) {
        this.directory = directory;
        this.ready = mkdir(directory, { recursive: true }).then(() => undefined, (err) => {
            logger.error("Could not create the storage directory — data will not persist.", {
                directory,
                error: err,
            });
        });
    }
    path(key) {
        return join(this.directory, `${key.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    }
    async read(key) {
        await this.ready;
        try {
            return JSON.parse(await readFile(this.path(key), "utf-8"));
        }
        catch (err) {
            if (err.code === "ENOENT")
                return undefined;
            logger.error("Failed to read stored value.", { key, error: err });
            return undefined;
        }
    }
    async write(key, value) {
        await this.ready;
        const target = this.path(key);
        const temporary = `${target}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(value), "utf-8");
        await rename(temporary, target);
    }
    async delete(key) {
        await this.ready;
        await rm(this.path(key), { force: true });
    }
    async keys() {
        await this.ready;
        const entries = await readdir(this.directory).catch(() => []);
        return entries
            .filter((name) => name.endsWith(".json"))
            .map((name) => name.slice(0, -5));
    }
}
export function createStorage(config, namespace) {
    return new FileStore(join(config.storage.dir, namespace));
}
export function dataPath(config, ...segments) {
    return join(config.storage.dir, ...segments);
}
const jsonStores = new Map();
export function createJsonStore(config, name, initial) {
    const file = dataPath(config, name);
    const existing = jsonStores.get(file);
    if (existing)
        return existing;
    let cache;
    let queue = Promise.resolve();
    async function loadFromDisk() {
        try {
            return JSON.parse(await readFile(file, "utf-8"));
        }
        catch (err) {
            const code = err.code;
            if (code === "ENOENT")
                return structuredClone(initial);
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
    async function save(value) {
        await mkdir(dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(value, null, 2), "utf-8");
        await rename(temporary, file);
    }
    function enqueue(task) {
        const result = queue.then(task, task);
        queue = result.catch(() => undefined);
        return result;
    }
    const store = {
        file,
        async read() {
            cache ??= await loadFromDisk();
            return cache;
        },
        write(value) {
            cache = value;
            return enqueue(() => save(value));
        },
        async update(mutate) {
            const data = await store.read();
            const result = await mutate(data);
            await enqueue(() => save(data));
            return result;
        },
    };
    jsonStores.set(file, store);
    return store;
}
