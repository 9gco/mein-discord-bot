import "dotenv/config";
import { resolve } from "node:path";
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}
let cached;
export function loadConfig() {
    cached ??= readConfig();
    return cached;
}
function readConfig() {
    const persistentDir = process.env["PERSISTENT_DATA_DIR"]?.trim() ?? "";
    return {
        token: requireEnv("DISCORD_TOKEN"),
        clientId: requireEnv("DISCORD_CLIENT_ID"),
        guildId: process.env["DISCORD_GUILD_ID"] ?? undefined,
        storage: {
            dir: persistentDir || resolve(process.cwd(), ".data"),
            durable: persistentDir.length > 0,
        },
        api: {
            port: Number(process.env["PORT"] ?? 3000),
            dashboard: process.env["DASHBOARD_ENABLED"] === "true"
                ? {
                    provider: "discord",
                    clientSecret: requireEnv("DISCORD_CLIENT_SECRET"),
                    sessionSecret: requireEnv("SESSION_SECRET"),
                    publicUrl: requireEnv("PUBLIC_URL").replace(/\/$/, ""),
                }
                : undefined,
        },
    };
}
