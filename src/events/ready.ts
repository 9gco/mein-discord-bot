import { ActivityType, Events, type Client } from "discord.js";
import { loadConfig } from "../config.js";
import { logger } from "../utils/logger.js";
import {
  connectToVerifyChannel,
  getVerifyConfig,
} from "../utils/verify.js";
import { resumeVerifyQueue } from "./voiceStateUpdate.js";
import type { BotEvent } from "./index.js";

/** Lässt den Bot dauerhaft in alle aktiven Verify-Kanäle beitreten. */
async function autoJoinVerifyChannels(client: Client<true>): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    try {
      const cfg = await getVerifyConfig(guild.id);
      if (!cfg.enabled || !cfg.channelId) continue;
      const channel = guild.channels.cache.get(cfg.channelId);
      if (!channel?.isVoiceBased()) continue;
      connectToVerifyChannel(guild, cfg.channelId);
      logger.info("Mit dem Verify-Kanal verbunden.", {
        guildId: guild.id,
        channelId: cfg.channelId,
      });
      // Der Bot aendert an den Kanalrechten nichts. Die Rechte im Pruef-Kanal
      // (View Channel, Connect, Senden) werden komplett von Hand in Discord
      // gesetzt - nur so ist sichergestellt, dass der Bot nichts davon
      // versehentlich ueberschreibt.
    } catch (err) {
      logger.error("Auto-Join in den Verify-Kanal fehlgeschlagen.", {
        guildId: guild.id,
        error: err,
      });
    }
  }
}

/**
 * Statuszeile unter dem Botnamen. Die Texte drehen alle `STATUS_WECHSEL_MS`
 * Millisekunden – so ist immer zu sehen, dass das Verify-System läuft.
 */
const STATUS_TEXTE = [
  "In der Warteschlange",
  "Prüfe neue Mitglieder",
  "Wartezeit",
];
const STATUS_WECHSEL_MS = 30_000;

function setBotStatus(client: Client<true>): void {
  let index = 0;

  const anzeigen = (): void => {
    void client.user.setPresence({
      status: "online",
      activities: [
        { type: ActivityType.Custom, name: STATUS_TEXTE[index] ?? "" },
      ],
    });
    index = (index + 1) % STATUS_TEXTE.length;
  };

  anzeigen();
  setInterval(anzeigen, STATUS_WECHSEL_MS).unref();
}

const event: BotEvent<Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,

async execute(client: Client<true>): Promise<void> {
    const { storage } = loadConfig();
    logger.info("Bot is online.", {
      tag: client.user.tag,
      dataDir: storage.dir,
      durableStorage: storage.durable,
    });
    setBotStatus(client);
    // Kurz warten, bis die Guilds/Kanäle geladen sind, dann beitreten und
    // eventuell noch wartende Mitglieder wieder aufnehmen.
    setImmediate(() => {
      void autoJoinVerifyChannels(client).then(() => resumeVerifyQueue(client));
    });
  },
};

export default event;
