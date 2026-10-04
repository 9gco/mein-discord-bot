import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Guild, GuildMember } from "discord.js";
import ffmpeg from "ffmpeg-static";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { loadConfig } from "../config.js";
import { createStorage } from "./storage.js";
import { logger } from "./logger.js";

// Stelle sicher, dass @discordjs/voice zum Transkodieren von MP3 → Opus
// das gebündelte ffmpeg von ffmpeg-static nutzt.
if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg;

export interface VerifyConfig {
  enabled: boolean;
  channelId?: string;
  /** Der Text, den der Bot im Voice-Kanal vorliest. {user} = Name des Nutzers. */
  message: string;
  /** Edge-TTS-Stimme (ShortName), z. B. "de-DE-KatjaNeural". */
  voice: string;
  /** Rollen, die nach der Ansage vergeben werden. */
  roles: string[];
}

const DEFAULT_CONFIG: VerifyConfig = {
  enabled: false,
  channelId: undefined,
  message:
    "Willkommen {user}. Du wirst gleich verifiziert. Bitte warte kurz.",
  voice: "de-DE-KatjaNeural",
  roles: [],
};

export const verifyStore = createStorage<VerifyConfig>(loadConfig(), "verify");

/**
 * Kuratierte, kostenlose Edge-TTS-Stimmen (kein API-Key nötig).
 * Die Namen wurden gegen die echte Stimmen-Liste des Dienstes geprüft.
 * Discord erlaubt maximal 25 Auswahlmöglichkeiten pro Option.
 */
export const VERIFY_VOICES = [
  // Deutsch
  { name: "de-DE-KatjaNeural", label: "Deutsch – Katja (weiblich)" },
  { name: "de-DE-AmalaNeural", label: "Deutsch – Amala (weiblich)" },
  {
    name: "de-DE-SeraphinaMultilingualNeural",
    label: "Deutsch – Seraphina (weiblich, multilingual)",
  },
  { name: "de-DE-ConradNeural", label: "Deutsch – Conrad (männlich)" },
  {
    name: "de-DE-FlorianMultilingualNeural",
    label: "Deutsch – Florian (männlich, multilingual)",
  },
  { name: "de-DE-KillianNeural", label: "Deutsch – Killian (männlich, jung)" },
  { name: "de-AT-IngridNeural", label: "Österreichisch – Ingrid (weiblich)" },
  { name: "de-AT-JonasNeural", label: "Österreichisch – Jonas (männlich)" },
  { name: "de-CH-LeniNeural", label: "Schweizerdeutsch – Leni (weiblich)" },
  { name: "de-CH-JanNeural", label: "Schweizerdeutsch – Jan (männlich)" },
  // Weitere Sprachen
  { name: "en-US-AvaNeural", label: "Englisch (US) – Ava (weiblich)" },
  { name: "en-US-AndrewNeural", label: "Englisch (US) – Andrew (männlich)" },
  { name: "en-GB-LibbyNeural", label: "Englisch (UK) – Libby (weiblich)" },
  { name: "tr-TR-EmelNeural", label: "Türkisch – Emel (weiblich)" },
  { name: "tr-TR-AhmetNeural", label: "Türkisch – Ahmet (männlich)" },
  { name: "fr-FR-DeniseNeural", label: "Französisch – Denise (weiblich)" },
  { name: "es-ES-AlvaroNeural", label: "Spanisch – Álvaro (männlich)" },
  { name: "it-IT-ElsaNeural", label: "Italienisch – Elsa (weiblich)" },
  { name: "pl-PL-ZofiaNeural", label: "Polnisch – Zofia (weiblich)" },
  { name: "ru-RU-SvetlanaNeural", label: "Russisch – Svetlana (weiblich)" },
  { name: "nl-NL-FennaNeural", label: "Niederländisch – Fenna (weiblich)" },
  { name: "pt-BR-FranciscaNeural", label: "Portugiesisch (BR) – Francisca" },
  { name: "ar-SA-ZariyahNeural", label: "Arabisch – Zariyah (weiblich)" },
  { name: "ja-JP-NanamiNeural", label: "Japanisch – Nanami (weiblich)" },
] as const;

/** Alte Sprachcodes → passende Edge-Stimme (Abwärtskompatibilität). */
const LEGACY_LANG_TO_VOICE: Record<string, string> = {
  de: "de-DE-KatjaNeural",
  en: "en-US-AvaNeural",
  fr: "fr-FR-DeniseNeural",
  es: "es-ES-AlvaroNeural",
  tr: "tr-TR-EmelNeural",
};

/** Konfigurationen werden im Speicher gehalten: Voice-Events dürfen keine
 *  Festplatten-Lesevorgänge vor dem Antworten auslösen. */
const configCache = new Map<string, VerifyConfig>();

function normalizeConfig(stored: Partial<VerifyConfig> | undefined): VerifyConfig {
  // Alt-Konfigurationen hatten "lang" (Sprachcode) bzw. "voice" (StreamElements).
  const legacy = stored as (VerifyConfig & { lang?: string }) | undefined;
  const storedVoice =
    typeof legacy?.voice === "string" && legacy.voice.includes("-")
      ? legacy.voice
      : legacy?.lang
        ? LEGACY_LANG_TO_VOICE[legacy.lang]
        : undefined;
  return {
    enabled: stored?.enabled ?? DEFAULT_CONFIG.enabled,
    channelId: stored?.channelId || undefined,
    message:
      typeof stored?.message === "string" && stored.message
        ? stored.message
        : DEFAULT_CONFIG.message,
    voice: storedVoice || DEFAULT_CONFIG.voice,
    roles: Array.isArray(stored?.roles) ? stored.roles : [],
  };
}

export async function getVerifyConfig(guildId: string): Promise<VerifyConfig> {
  const cached = configCache.get(guildId);
  if (cached) return cached;
  const cfg = normalizeConfig(await verifyStore.read(guildId));
  configCache.set(guildId, cfg);
  return cfg;
}

/**
 * Synchrone Variante — nötig, wenn vor dem Öffnen eines Modals nichts
 * awaited werden darf. Fällt auf die Standardwerte zurück, wenn die
 * Konfiguration noch nicht gelesen wurde.
 */
export function getCachedVerifyConfig(guildId: string): VerifyConfig {
  const cached = configCache.get(guildId);
  if (!cached) return { ...DEFAULT_CONFIG, roles: [] };
  return { ...cached, roles: [...cached.roles] };
}

/** Schreibt die Konfiguration und hält den Cache aktuell. */
export async function saveVerifyConfig(
  guildId: string,
  cfg: VerifyConfig,
): Promise<void> {
  configCache.set(guildId, cfg);
  await verifyStore.write(guildId, cfg);
}

/**
 * Erzeugt TTS-Audio (MP3) über den kostenlosen Microsoft Edge-Sprachdienst
 * (kein API-Key nötig, läuft server-seitig). Ergebnisse werden zwischen-
 * gespeichert, damit dieselbe Ansage nicht erneut synthetisiert wird.
 */
const TTS_CACHE_LIMIT = 40;
const ttsCache = new Map<string, Buffer>();

export async function fetchTtsAudio(text: string, voice: string): Promise<Buffer> {
  const cacheKey = `${voice}::${text}`;
  const cached = ttsCache.get(cacheKey);
  if (cached) return cached;

  const buffer = await synthesizeSpeech(text, voice);

  ttsCache.set(cacheKey, buffer);
  while (ttsCache.size > TTS_CACHE_LIMIT) {
    const oldest = ttsCache.keys().next().value;
    if (oldest === undefined) break;
    ttsCache.delete(oldest);
  }
  return buffer;
}

async function synthesizeSpeech(text: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      audioStream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      audioStream.once("end", () => resolve());
      audioStream.once("error", (err: Error) => reject(err));
    });
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) throw new Error("TTS returned an empty file.");
    return buffer;
  } finally {
    tts.close();
  }
}

/**
 * Stellt sicher, dass der Bot im Ziel-Voice-Kanal verbunden und bereit ist.
 * Wartet bis zur Ready-State, sonst wird das Audio von Discord verworfen.
 */
export async function connectToVerifyChannel(
  guild: Guild,
  channelId: string,
): Promise<VoiceConnection | undefined> {
  const existing = getVoiceConnection(guild.id);
  if (existing && existing.joinConfig.channelId === channelId) {
    if (existing.state.status === VoiceConnectionStatus.Ready) return existing;
  }
  const connection =
    existing && existing.joinConfig.channelId === channelId
      ? existing
      : joinVoiceChannel({
          guildId: guild.id,
          channelId,
          adapterCreator: guild.voiceAdapterCreator,
          // Mikrofon stumm, damit keine Geräusche übertragen werden; Audio wird
          // explizit über den Audio-Player abgespielt.
          selfMute: true,
          selfDeaf: false,
        });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch {
    connection.destroy();
    return undefined;
  }
  return connection;
}

/**
 * Spielt einen Audio-Puffer über die bestehende Verbindung ab und wartet bis
 * zum Ende. Der Notausstieg richtet sich nach der Länge des Audios, damit
 * lange Ansagen nicht abgeschnitten werden.
 */
export function playBuffer(
  connection: VoiceConnection,
  buffer: Buffer,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const player = createAudioPlayer();
    const resource = createAudioResource(Readable.from(buffer), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });

    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        try {
          player.stop();
        } catch {
          // Player war bereits fertig.
        }
      }
      resolve();
    };

    // Das MP3 kommt mit ca. 48 kbit/s (~6 kB/s). Bewusst konservativ schätzen
    // (5 kB/s) und großzügig Puffer drauflegen.
    const estimatedMs = Math.ceil((buffer.length / 5000) * 1000);
    timer = setTimeout(() => {
      logger.warn("Audio-Wiedergabe-Timeout – Ansage wurde abgebrochen.", {
        estimatedMs,
        bytes: buffer.length,
      });
      finish(true);
    }, estimatedMs + 20_000);

    player.once(AudioPlayerStatus.Idle, () => finish(false));
    player.once("error", (err) => {
      logger.error("Audio-Player-Fehler während der Verifizierung.", {
        error: err,
      });
      finish(false);
    });

    connection.subscribe(player);
    player.play(resource);
  });
}

/**
 * Führt Aufgaben pro Guild streng nacheinander aus.
 *
 * Ohne das würden mehrere gleichzeitige Joins mehrere Audio-Player auf
 * dieselbe Voice-Verbindung legen: der zweite `subscribe()` ersetzt den
 * ersten, dessen Wiedergabe nie beendet wird und in den Timeout läuft.
 */
const guildQueues = new Map<string, Promise<void>>();

export function runExclusive(
  guildId: string,
  task: () => Promise<void>,
): Promise<void> {
  const previous = guildQueues.get(guildId) ?? Promise.resolve();
  const next = previous
    .then(() => task())
    .catch((err) => {
      logger.error("Verify-Aufgabe fehlgeschlagen.", { guildId, error: err });
    });

  guildQueues.set(guildId, next);
  void next.finally(() => {
    // Nur aufräumen, wenn niemand weiteres ansteht.
    if (guildQueues.get(guildId) === next) guildQueues.delete(guildId);
  });
  return next;
}
