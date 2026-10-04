import "dotenv/config";
import { resolve } from "node:path";

export interface BotConfig {
  token: string;
  clientId: string;
  guildId?: string;
  storage: {
    /**
     * Where runtime data lives. Set `PERSISTENT_DATA_DIR` to a mounted volume
     * (for example `/data` on Railway) so the data survives redeployments.
     * Without it a local directory is used that every redeploy wipes.
     */
    dir: string;
    /** False when falling back to a local directory that a redeploy wipes. */
    durable: boolean;
  };
  api: {
    port: number;
    dashboard?: {
      provider: "discord";
      clientSecret: string;
      sessionSecret: string;
      publicUrl: string;
    };
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

let cached: BotConfig | undefined;

/**
 * The bot's configuration. Read from the environment on first call and cached,
 * so any module can call this and get the same object — feature code does not
 * need config passed down to it.
 */
export function loadConfig(): BotConfig {
  cached ??= readConfig();
  return cached;
}

function readConfig(): BotConfig {
  // Points at a mounted volume; set it to keep runtime data across redeploys.
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
      dashboard:
        process.env["DASHBOARD_ENABLED"] === "true"
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
