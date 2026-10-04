import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import OpusScript from "opusscript";
import ffmpeg from "ffmpeg-static";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { loadConfig } from "../config.js";
import { createStorage } from "./storage.js";
import { logger } from "./logger.js";

// Stelle sicher, dass @discordjs/voice zum Transkodieren von MP3 â†’ Opus
// das gebÃ¼ndelte ffmpeg von ffmpeg-static nutzt.
if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg;

export interface VerifyConfig {
  enabled: boolean;
  /** Voice-Kanal, in dem geprÃ¼ft wird (Standard: VERIFY_CHANNEL_ID). */
  channelId?: string;
  /** Voice-Kanal, in dem Mitglieder zunÃ¤chst warten (Standard: WAITING_CHANNEL_ID). */
  waitingChannelId?: string;
/**
 * Altbestand aus früheren Versionen: es gab einmal eine Prüf-Rolle, die
 * dauerhaft vergeben wurde. Wird nicht mehr verwendet, bleibt nur im Typ,
 * damit gespeicherte Konfigurationen geladen werden können.
 */
  micRoleId?: string;
  /** Der Text, den der Bot im Voice-Kanal vorliest. {user} = Name des Nutzers. */
  message: string;
  /** Ansage, wenn das Mikrofon nicht brauchbar ist. */
  micFailedMessage: string;
  /**
   * Ansage, mit der das Sprechrecht freigeschaltet wird. Erst danach darf das
   * Mitglied im PrÃ¼f-Kanal reden.
   */
  speakNowMessage: string;
  /** Ansage, wenn der Mikrofon-Check erfolgreich war. */
  micPassedMessage: string;
  /** Edge-TTS-Stimme (ShortName), z. B. "de-DE-KatjaNeural". */
  voice: string;
  /** Rollen, die nach der Ansage vergeben werden. */
  roles: string[];
}

/** Kanal, in dem Mitglieder warten, bevor sie gezogen werden. */
export const WAITING_CHANNEL_ID = "1547675527844864020";
/** Kanal, in dem Ansage und Mikrofon-Check laufen. */
export const VERIFY_CHANNEL_ID = "1547676303149244508";
/**
 * Rolle, die dauerhaft an geprüfte Mitglieder vergeben wird. Sie bleibt
 * dauerhaft und wird vom Bot nicht angefasst.
 *
 * Für den Zugang zum Prüf-Kanal ist sie nicht zuständig: `@everyone` hat im
 * Prüf-Kanal weder "Kanäle ansehen" noch "Verbinden", damit sich niemand
 * selbst eintragen kann. Der Bot zieht seine Wartenden mit "Move Members"
 * trotzdem hinein, und "Senden" steht für alle offen, damit sie dort reden
 * können.
 */
export const MIC_CHECK_ROLE_ID = "1547675358948753418";

const DEFAULT_CONFIG: VerifyConfig = {
  enabled: true,
  channelId: VERIFY_CHANNEL_ID,
  waitingChannelId: WAITING_CHANNEL_ID,
  
  message:
    "Willkommen in der Whitelist, {user}. SchÃ¶n, dass du den Weg zu uns gefunden hast. " +
    "Ich habe dich hierher in den PrÃ¼f-Kanal geholt. Damit wir dich im Voice-Chat gut " +
    "verstehen, machen wir gleich einen kurzen Mikrofon-Check.",
  speakNowMessage:
    "So, {user}, du kannst jetzt sprechen. Sag einfach ein paar SÃ¤tze fÃ¼r mich, " +
    "ich hÃ¶re zu.",
  micFailedMessage:
    "PrÃ¼fe bitte deine Discord-Sende-Einstellung und deine EingabelautstÃ¤rke, stelle " +
    "dein Mikrofon ein und komm anschlieÃŸend noch einmal in den Warteraum.",
  micPassedMessage:
    "Perfekt, {user}, dein Mikrofon funktioniert einwandfrei. Ich schlieÃŸe die " +
    "PrÃ¼fung ab und schalte die KanÃ¤le fÃ¼r dich frei.",
  voice: "de-DE-KatjaNeural",
  roles: [],
};

export const verifyStore = createStorage<VerifyConfig>(loadConfig(), "verify");

/**
 * Kuratierte, kostenlose Edge-TTS-Stimmen (kein API-Key nÃ¶tig).
 * Die Namen wurden gegen die echte Stimmen-Liste des Dienstes geprÃ¼ft.
 * Discord erlaubt maximal 25 AuswahlmÃ¶glichkeiten pro Option.
 */
export const VERIFY_VOICES = [
  // Deutsch
  { name: "de-DE-KatjaNeural", label: "Deutsch â€“ Katja (weiblich)" },
  { name: "de-DE-AmalaNeural", label: "Deutsch â€“ Amala (weiblich)" },
  {
    name: "de-DE-SeraphinaMultilingualNeural",
    label: "Deutsch â€“ Seraphina (weiblich, multilingual)",
  },
  { name: "de-DE-ConradNeural", label: "Deutsch â€“ Conrad (mÃ¤nnlich)" },
  {
    name: "de-DE-FlorianMultilingualNeural",
    label: "Deutsch â€“ Florian (mÃ¤nnlich, multilingual)",
  },
  { name: "de-DE-KillianNeural", label: "Deutsch â€“ Killian (mÃ¤nnlich, jung)" },
  { name: "de-AT-IngridNeural", label: "Ã–sterreichisch â€“ Ingrid (weiblich)" },
  { name: "de-AT-JonasNeural", label: "Ã–sterreichisch â€“ Jonas (mÃ¤nnlich)" },
  { name: "de-CH-LeniNeural", label: "Schweizerdeutsch â€“ Leni (weiblich)" },
  { name: "de-CH-JanNeural", label: "Schweizerdeutsch â€“ Jan (mÃ¤nnlich)" },
  // Weitere Sprachen
  { name: "en-US-AvaNeural", label: "Englisch (US) â€“ Ava (weiblich)" },
  { name: "en-US-AndrewNeural", label: "Englisch (US) â€“ Andrew (mÃ¤nnlich)" },
  { name: "en-GB-LibbyNeural", label: "Englisch (UK) â€“ Libby (weiblich)" },
  { name: "tr-TR-EmelNeural", label: "TÃ¼rkisch â€“ Emel (weiblich)" },
  { name: "tr-TR-AhmetNeural", label: "TÃ¼rkisch â€“ Ahmet (mÃ¤nnlich)" },
  { name: "fr-FR-DeniseNeural", label: "FranzÃ¶sisch â€“ Denise (weiblich)" },
  { name: "es-ES-AlvaroNeural", label: "Spanisch â€“ Ãlvaro (mÃ¤nnlich)" },
  { name: "it-IT-ElsaNeural", label: "Italienisch â€“ Elsa (weiblich)" },
  { name: "pl-PL-ZofiaNeural", label: "Polnisch â€“ Zofia (weiblich)" },
  { name: "ru-RU-SvetlanaNeural", label: "Russisch â€“ Svetlana (weiblich)" },
  { name: "nl-NL-FennaNeural", label: "NiederlÃ¤ndisch â€“ Fenna (weiblich)" },
  { name: "pt-BR-FranciscaNeural", label: "Portugiesisch (BR) â€“ Francisca" },
  { name: "ar-SA-ZariyahNeural", label: "Arabisch â€“ Zariyah (weiblich)" },
  { name: "ja-JP-NanamiNeural", label: "Japanisch â€“ Nanami (weiblich)" },
] as const;

/** Alte Sprachcodes â†’ passende Edge-Stimme (AbwÃ¤rtskompatibilitÃ¤t). */
const LEGACY_LANG_TO_VOICE: Record<string, string> = {
  de: "de-DE-KatjaNeural",
  en: "en-US-AvaNeural",
  fr: "fr-FR-DeniseNeural",
  es: "es-ES-AlvaroNeural",
  tr: "tr-TR-EmelNeural",
};

/** Konfigurationen werden im Speicher gehalten: Voice-Events dÃ¼rfen keine
 *  Festplatten-LesevorgÃ¤nge vor dem Antworten auslÃ¶sen. */
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
    channelId: stored?.channelId || VERIFY_CHANNEL_ID,
    waitingChannelId: stored?.waitingChannelId || WAITING_CHANNEL_ID,
    
    message:
      typeof stored?.message === "string" && stored.message
        ? stored.message
        : DEFAULT_CONFIG.message,
    micFailedMessage:
      typeof stored?.micFailedMessage === "string" && stored.micFailedMessage
        ? stored.micFailedMessage
        : DEFAULT_CONFIG.micFailedMessage,
    speakNowMessage:
      typeof stored?.speakNowMessage === "string" && stored.speakNowMessage
        ? stored.speakNowMessage
        : DEFAULT_CONFIG.speakNowMessage,
    micPassedMessage:
      typeof stored?.micPassedMessage === "string" && stored.micPassedMessage
        ? stored.micPassedMessage
        : DEFAULT_CONFIG.micPassedMessage,
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
 * Synchrone Variante â€” nÃ¶tig, wenn vor dem Ã–ffnen eines Modals nichts
 * awaited werden darf. FÃ¤llt auf die Standardwerte zurÃ¼ck, wenn die
 * Konfiguration noch nicht gelesen wurde.
 */
export function getCachedVerifyConfig(guildId: string): VerifyConfig {
  const cached = configCache.get(guildId);
  if (!cached) return { ...DEFAULT_CONFIG, roles: [] };
  return { ...cached, roles: [...cached.roles] };
}

/** Schreibt die Konfiguration und hÃ¤lt den Cache aktuell. */
export async function saveVerifyConfig(
  guildId: string,
  cfg: VerifyConfig,
): Promise<void> {
  configCache.set(guildId, cfg);
  await verifyStore.write(guildId, cfg);
}

/**
 * Erzeugt TTS-Audio (MP3) Ã¼ber den kostenlosen Microsoft Edge-Sprachdienst
 * (kein API-Key nÃ¶tig, lÃ¤uft server-seitig). Ergebnisse werden zwischen-
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
/**
 * Wird geworfen, wenn ein PrÃ¼f-Durchlauf abbricht, weil das Mitglied den
 * Kanal vorher verlassen hat. Kein Fehlerfall, sondern normales Ende.
 */
export class VerifyAbortedError extends Error {
  constructor(reason = "PrÃ¼fung abgebrochen") {
    super(reason);
    this.name = "VerifyAbortedError";
  }
}

/** PrÃ¼ft, ob ein Durchlauf noch laufen darf, und wirft sonst. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VerifyAbortedError();
}

/** `setTimeout`, das bei Abbruch sofort wieder zurÃ¼ckkehrt. */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new VerifyAbortedError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new VerifyAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Registriert einen Abbruch-Handler und liefert die AufrÃ¤umfunktion. */
export function onAbort(signal: AbortSignal | undefined, fn: () => void): () => void {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    fn();
    return () => undefined;
  }
  signal.addEventListener("abort", fn, { once: true });
  return () => signal.removeEventListener("abort", fn);
}

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
          // Mikrofon stumm, damit keine GerÃ¤usche Ã¼bertragen werden; Audio wird
          // explizit Ã¼ber den Audio-Player abgespielt.
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
 * Liest die aktuellen Kanalrechte eines Mitglieds im Prüf-Kanal und
 * protokolliert sie. Der Bot aendert an den Rechten nichts mehr - die
 * Kanal-Einstellungen werden komplett von Hand in Discord gemacht.
 *
 * Nur zur Diagnose: wenn ein Mitglied im Prüf-Kanal nicht sprechen kann,
 * steht hier, welcher Baustein blockiert.
 */
export function logVerifyPermissions(
  guild: Guild,
  channelId: string,
  memberId: string,
): void {
  const member = guild.members.cache.get(memberId);
  if (!member) return;
  const perms = member.permissionsIn(channelId);

  // Rollen, die im Kanal "Senden: aus" haben und damit das Mitglied
  // stumm halten. Ein Rollen-Override gewinnt gegen den Rest.
  const channel = guild.channels.cache.get(channelId);
  const blockingRoles = member.roles.cache
    .filter(
      (role) =>
        channel?.isVoiceBased() &&
        channel.permissionOverwrites.cache
          .get(role.id)
          ?.deny.has(PermissionFlagsBits.Speak),
    )
    .map((role) => role.id);

  logger.info("Kanalrechte (nur gelesen, nicht geaendert).", {
    guildId: guild.id,
    channelId,
    userId: memberId,
    viewChannel: perms.has(PermissionFlagsBits.ViewChannel),
    connect: perms.has(PermissionFlagsBits.Connect),
    speak: perms.has(PermissionFlagsBits.Speak),
    blockingRoles,
  });
}

/**
 * Spielt einen Audio-Puffer Ã¼ber die bestehende Verbindung ab und wartet bis
 * zum Ende. Der Notausstieg richtet sich nach der LÃ¤nge des Audios, damit
 * lange Ansagen nicht abgeschnitten werden.
 */
export function playBuffer(
  connection: VoiceConnection,
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let detachAbort: () => void = () => undefined;

    const player = createAudioPlayer();
    const resource = createAudioResource(Readable.from(buffer), {
      inputType: StreamType.Arbitrary,
      inlineVolume: true,
    });

    const finish = (timedOut: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      detachAbort();
      try {
        // Bei Abbruch muss der Player sofort stoppen, sonst redet der Bot
        // in einen leeren Kanal weiter.
        player.stop(true);
      } catch {
        // Player war bereits fertig.
      }
      if (timedOut) {
        logger.warn("Ansage wurde abgebrochen.", {
          estimatedMs,
          bytes: buffer.length,
        });
      }
      resolve();
    };

    // Das MP3 kommt mit ca. 48 kbit/s (~6 kB/s). Bewusst konservativ schÃ¤tzen
    // (5 kB/s) und groÃŸzÃ¼gig Puffer drauflegen.
    const estimatedMs = Math.ceil((buffer.length / 5000) * 1000);
    timer = setTimeout(
      () => finish(true),
      estimatedMs + 20_000,
    );

    player.once(AudioPlayerStatus.Idle, () => finish(false));
    player.once("error", (err: Error) => {
      logger.error("Audio-Player-Fehler wÃ¤hrend der Verifizierung.", {
        error: err,
      });
      finish(false);
    });

    detachAbort = onAbort(signal, () => finish(false));

    connection.subscribe(player);
    player.play(resource);
  });
}

/**
 * FÃ¼hrt Aufgaben pro Guild streng nacheinander aus.
 *
 * Ohne das wÃ¼rden mehrere gleichzeitige Joins mehrere Audio-Player auf
 * dieselbe Voice-Verbindung legen: der zweite `subscribe()` ersetzt den
 * ersten, dessen Wiedergabe nie beendet wird und in den Timeout lÃ¤uft.
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
    // Nur aufrÃ¤umen, wenn niemand weiteres ansteht.
    if (guildQueues.get(guildId) === next) guildQueues.delete(guildId);
  });
  return next;
}

// ---------------------------------------------------------------------------
// Mikrofon-Check
// ---------------------------------------------------------------------------

/** Mindest-Sprechdauer, damit ein Versuch als "geredet" gilt. */
const MIC_MIN_SPEECH_MS = 800;
/** Ab diesem RMS-Pegel gilt ein Frame als "da ist Sprache" (Stille-Rauschen liegt darunter). */
const MIC_SPEECH_FLOOR = 0.006;
/** Mindest-Durchschnittspegel (RMS, 0..1) â€” darunter gilt das Mikrofon als zu leise. */
const MIC_MIN_LEVEL = 0.03;
/** Ab diesem Spitzenwert gilt das Signal als Ã¼bersteuert. */
const MIC_CLIP_PEAK = 0.97;
/** Sprache muss mindestens so viel lauter sein wie der Rauschboden (Faktor â‰ˆ +12 dB). */
const MIC_MIN_SNR = 4;
/** Wie viele Stille-Frames wir mindestens brauchen, um den Rauschboden zu schÃ¤tzen. */
const MIC_MIN_NOISE_FRAMES = 5;
/** Wie lange auf Sprache gewartet wird, bevor der Check als "nichts gehÃ¶rt" endet. */
const MIC_MAX_WAIT_MS = 45_000;
/** Opus-Abtastrate und FramegrÃ¶ÃŸe fÃ¼r Discord-Voice (20 ms). */
const OPUS_RATE = 48_000;
const OPUS_FRAME_MS = 20;

export type MicCheckReason =
  | "no_speech"
  | "too_short"
  | "too_quiet"
  | "clipping"
  | "noisy"
  /** Abbruch, weil das Mitglied den Kanal vorzeitig verlassen hat. */
  | "aborted"
  | "error";

export interface MicCheckResult {
  /** true = Mikrofon brauchbar, Verifizierung darf weiterlaufen. */
  ok: boolean;
  /** Grund fÃ¼r ein Scheitern, nur gesetzt wenn ok === false. */
  reason?: MicCheckReason;
  /** Gemessene Sprechzeit in Millisekunden. */
  speechMs: number;
  /** Gemessener mittlerer Sprechpegel (0..1). */
  level: number;
  /** HÃ¶chster Spitzenwert im Signal (0..1), 1 = voll aufgedreht. */
  peak: number;
  /** VerhÃ¤ltnis Sprechpegel zu Rauschboden. */
  snr: number;
}

/** Rohwerte, die `judgeMicMeasurement` bewertet. */
export interface MicMeasurement {
  /** Gemessene Sprechzeit in Millisekunden. */
  speechMs: number;
  /** Mittlerer Pegel der Sprachframes (0..1). */
  level: number;
  /** HÃ¶chster Spitzenwert der Sprachframes (0..1). */
  peak: number;
  /** VerhÃ¤ltnis Sprechpegel zu Rauschboden, 0 wenn nicht schÃ¤tzbar. */
  snr: number;
  /** true, wenn der Rauschboden aus genug Stille-Frames geschÃ¤tzt wurde. */
  noiseKnown: boolean;
  /** false, wenn ohne Opus-Decoder nur die Sprechdauer gemessen wurde. */
  hasLevels: boolean;
}

/**
 * Bewertet eine Messung. Reihenfolge ist bewusst: erst muss Ã¼berhaupt etwas
 * Brauchbares angekommen sein, danach erst QualitÃ¤tskriterien â€“ sonst wÃ¼rde ein
 * stummes Mikrofon als "Ã¼bersteuert" gemeldet.
 *
 * Reihenfolge: kein Ton â†’ zu kurz â†’ keine Pegeldaten â†’ Ã¼bersteuert â†’
 * zu leise â†’ zu verrauscht â†’ bestanden.
 */
export function judgeMicMeasurement(
  m: MicMeasurement,
): MicCheckReason | "ok" {
  if (m.speechMs === 0) return "no_speech";
  if (m.speechMs < MIC_MIN_SPEECH_MS) return "too_short";
  // Ohne Decoder gibt es keine Pegelmessung â€“ dann zÃ¤hlt nur die Sprechdauer.
  if (!m.hasLevels) return "ok";
  if (m.peak >= MIC_CLIP_PEAK) return "clipping";
  if (m.level < MIC_MIN_LEVEL) return "too_quiet";
  if (m.noiseKnown && m.snr < MIC_MIN_SNR) return "noisy";
  return "ok";
}

/** Pegel eines Opus-Pakets: RMS (LautstÃ¤rke) und Spitzenwert (Clipping). */
interface FrameLevel {
  /** Mittlerer Betrag des Signals, 0..1. */
  rms: number;
  /** GrÃ¶ÃŸter Einzelwert, 0..1. Nahe 1 heiÃŸt Ã¼bersteuert. */
  peak: number;
}

const SILENT_FRAME: FrameLevel = { rms: 0, peak: 0 };

/**
 * Pegel eines Opus-Pakets. Discord liefert Opus, `opusscript` dekodiert zu
 * PCM; daraus werden RMS und Spitzenwert gebildet. Fehler (z. B. fehlendes
 * WASM) liefern ein stummes Frame, dann greift der Pegel-Check als "leer".
 */
function measureFrame(
  decoder: OpusScript | undefined,
  packet: Buffer,
): FrameLevel {
  if (!decoder) return SILENT_FRAME;
  try {
    const pcm = decoder.decode(packet);
    if (!pcm || pcm.length === 0) return SILENT_FRAME;
    let sum = 0;
    let peak = 0;
    let samples = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const sample = Math.abs(pcm.readInt16LE(i) / 32768);
      sum += sample * sample;
      if (sample > peak) peak = sample;
      samples++;
    }
    return {
      rms: samples > 0 ? Math.sqrt(sum / samples) : 0,
      peak,
    };
  } catch {
    return SILENT_FRAME;
  }
}

/**
 * Wartet, bis niemand im Kanal spricht, damit der Bot nicht mitten in einen
 * Satz redet. `graceMs` ist eine kleine Schonzeit nach dem letzten Sprecher,
 * damit Ansagen sich nicht Ã¼berlappen.
 */
export function waitForSilence(
  connection: VoiceConnection,
  graceMs = 700,
  maxWaitMs = 60_000,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const speaking = connection.receiver.speaking;
    let settled = false;
    let active = 0;
    let graceTimer: NodeJS.Timeout | undefined;
    let hardTimeout: NodeJS.Timeout | undefined;
    let detachAbort: () => void = () => undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      detachAbort();
      speaking.off("start", onStart);
      speaking.off("end", onEnd);
      resolve();
    };

    const startGrace = (): void => {
      if (graceTimer) clearTimeout(graceTimer);
      graceTimer = setTimeout(finish, graceMs);
    };

    function onStart(): void {
      active++;
      if (graceTimer) clearTimeout(graceTimer);
    }

    function onEnd(): void {
      active = Math.max(0, active - 1);
      if (active === 0) startGrace();
    }

    hardTimeout = setTimeout(finish, maxWaitMs);
    speaking.on("start", onStart);
    speaking.on("end", onEnd);
    detachAbort = onAbort(signal, finish);

    // Wer schon spricht, zÃ¤hlt ebenfalls als belegt.
    if (speaking.users.size > 0) active = speaking.users.size;
    startGrace();
  });
}

/**
 * Nimmt die Stimme eines Mitglieds Ã¼ber den Voice-Receiver auf und bewertet,
 * ob das Mikrofon brauchbar ist. GeprÃ¼ft wird in dieser Reihenfolge:
 *
 * 1. `no_speech`  â€“ in `MIC_MAX_WAIT_MS` kam kein verwertbarer Ton
 * 2. `too_short`  â€“ zu wenig Sprechzeit zum Beurteilen
 * 3. `clipping`   â€“ Signal Ã¼bersteuert (Gain zu hoch)
 * 4. `too_quiet`  â€“ Sprechpegel unter `MIC_MIN_LEVEL`
 * 5. `noisy`      â€“ Sprache hebt sich kaum vom Rauschboden ab
 *
 * Der Check endet nach einer kurzen Stille nach der Sprachphase. Wer gar
 * nichts aufnimmt, wartet bis `MIC_MAX_WAIT_MS`.
 */
export function runMicCheck(
  connection: VoiceConnection,
  memberId: string,
  signal?: AbortSignal,
): Promise<MicCheckResult> {
  return new Promise((resolve) => {
    let decoder: OpusScript | undefined;
    try {
      decoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP);
    } catch (err) {
      logger.warn("Opus-Decoder nicht verfÃ¼gbar â€“ nur Sprech-Erkennung.", {
        error: err,
      });
      decoder = undefined;
    }

let settled = false;
    /** Frames, die als Sprache gewertet wurden â€“ Pegelsumme und Spitzenwert. */
    let voiceFrames = 0;
    let levelSum = 0;
    /** HÃ¶chster Spitzenwert Ã¼ber alle Sprachframes â€“ fÃ¼r die Clipping-PrÃ¼fung. */
    let peakMax = 0;
    /** Frames, die als Rauschen gewertet wurden â€“ Grundlage des Rauschbodens. */
    let noiseFrames = 0;
    let noiseSum = 0;
    /** Alle Frame-Pegel, fÃ¼r die Neuberechnung, falls die Speaking-Events fehlen. */
    const frameLevels: number[] = [];
    const framePeaks: number[] = [];
    /** Discord meldet zuverlÃ¤ssig, wann das Mitglied wirklich sendet. */
    let isSpeaking = false;
    let sawSpeakingEvent = false;
    let silentTimer: NodeJS.Timeout | undefined;
    let hardTimeout: NodeJS.Timeout | undefined;
    /** ZusÃ¤tzliche Abmeldungen, die beim Beenden des Checks ausgefÃ¼hrt werden. */
    const detachers: Array<() => void> = [];

    const speechMs = (): number => voiceFrames * OPUS_FRAME_MS;

    const level = (): number => (voiceFrames > 0 ? levelSum / voiceFrames : 0);

    const snr = (): number => {
      if (noiseFrames < MIC_MIN_NOISE_FRAMES || voiceFrames === 0) return 0;
      const noise = noiseSum / noiseFrames;
      // Rauschboden nahe 0 â†’ VerhÃ¤ltnis ist unendlich groÃŸ, das ist in Ordnung.
      if (noise <= 0) return Number.POSITIVE_INFINITY;
      return level() / noise;
    };

    /**
     * Ohne Speaking-Events lÃ¤sst sich Sprache nicht von dauerhaftem
     * Hintergrundrauschen trennen. In dem Fall wird ersatzweise am Pegel
     * unterschieden â€“ ungenauer, aber besser als ein Fehlschlag fÃ¼r alle.
     */
    const reclassifyByLevel = (): void => {
      voiceFrames = 0;
      levelSum = 0;
      peakMax = 0;
      noiseFrames = 0;
      noiseSum = 0;
      for (let i = 0; i < frameLevels.length; i++) {
        const rms = frameLevels[i] ?? 0;
        if (rms >= MIC_SPEECH_FLOOR) {
          voiceFrames++;
          levelSum += rms;
          const peak = framePeaks[i] ?? 0;
          if (peak > peakMax) peakMax = peak;
        } else {
          noiseFrames++;
          noiseSum += rms;
        }
      }
    };

    const finish = (outcome: MicCheckResult): void => {
      if (settled) return;
      settled = true;
      if (silentTimer) clearTimeout(silentTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      for (const detach of detachers) {
        try {
          detach();
        } catch {
          // AufrÃ¤umen ist bestmÃ¶glich.
        }
      }
      try {
        subscription.destroy();
      } catch {
        // Stream war schon beendet.
      }
      try {
        decoder?.delete();
      } catch {
        // Decoder bereits freigegeben.
      }
      resolve(outcome);
    };

    // Auswertung: erst Bewertung, dann finish(), weil finish() die Werte liest.
    const evaluate = (): void => {
      // Speaking-Events vorhanden? Wenn nicht, auf reine Pegelbewertung zurÃ¼ckfallen.
      if (!sawSpeakingEvent && frameLevels.length >= MIC_MIN_NOISE_FRAMES * 2) {
        reclassifyByLevel();
      }

      const metrics = {
        speechMs: speechMs(),
        level: level(),
        peak: peakMax,
        snr: snr(),
      };
      const verdict = judgeMicMeasurement({
        speechMs: metrics.speechMs,
        level: metrics.level,
        peak: metrics.peak,
        snr: metrics.snr,
        noiseKnown: noiseFrames >= MIC_MIN_NOISE_FRAMES,
        hasLevels: decoder !== undefined,
      });

      if (verdict === "ok") {
        finish({ ok: true, ...metrics });
      } else {
        finish({ ok: false, reason: verdict, ...metrics });
      }
    };

    const restartSilenceTimer = (): void => {
      if (silentTimer) clearTimeout(silentTimer);
      silentTimer = setTimeout(evaluate, 1500);
    };

    const subscription = connection.receiver.subscribe(memberId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 400,
      },
    });

    hardTimeout = setTimeout(evaluate, MIC_MAX_WAIT_MS);

    // Bricht das Mitglied vorher ab, endet der Check sofort â€“ sonst wÃ¼rde die
    // ganze Schlange bis zu MIC_MAX_WAIT_MS blockiert bleiben.
    detachers.push(
      onAbort(signal, () => {
        finish({ ok: false, reason: "aborted", speechMs: 0, level: 0, peak: 0, snr: 0 });
      }),
    );

    // Speaking-Events sind die verlÃ¤sslichste Trennung zwischen Sprache und
    // Rauschen â€“ der Pegel allein reicht bei laufendem Hintergrund nicht.
    const speaking = connection.receiver.speaking;
    const onSpeakStart = (userId: string): void => {
      if (userId !== memberId) return;
      isSpeaking = true;
      sawSpeakingEvent = true;
      // Erstes HÃ¶ren beendet das Warten auf eine Maximaldauer.
      if (hardTimeout) clearTimeout(hardTimeout);
    };
    const onSpeakEnd = (userId: string): void => {
      if (userId !== memberId) return;
      isSpeaking = false;
      restartSilenceTimer();
    };
    speaking.on("start", onSpeakStart);
    speaking.on("end", onSpeakEnd);
    detachers.push(() => {
      speaking.off("start", onSpeakStart);
      speaking.off("end", onSpeakEnd);
    });

    subscription.on("data", (packet: Buffer) => {
      if (settled || packet.length === 0) return;
      const { rms, peak } = measureFrame(decoder, packet);
      frameLevels.push(rms);
      framePeaks.push(peak);

      if (isSpeaking && rms >= MIC_SPEECH_FLOOR) {
        voiceFrames++;
        levelSum += rms;
        if (peak > peakMax) peakMax = peak;
      } else {
        noiseFrames++;
        noiseSum += rms;
      }

      // Solange gesendet wird, lÃ¤uft die Zeit weiter.
      if (isSpeaking) restartSilenceTimer();
    });

    subscription.once("end", () => {
      // Kurze Stille am Ende noch abwarten, dann auswerten.
      restartSilenceTimer();
    });

    subscription.once("error", (err: Error) => {
      logger.error("Fehler beim Mikrofon-Check.", {
        userId: memberId,
        error: err,
      });
      finish({ ok: false, reason: "error", speechMs: 0, level: 0, peak: 0, snr: 0 });
    });
  });
}

// ---------------------------------------------------------------------------
// Warteschlange und Namensnummern
// ---------------------------------------------------------------------------

interface QueueEntry {
  userId: string;
  /** Nickname vor dem Setzen des "(n) "-PrÃ¤fix. */
  originalNick: string | null;
  originalName: string;
}

/** guildId â†’ Reihenfolge der Wartenden (Join-Reihenfolge). */
const waitingOrder = new Map<string, string[]>();
/** "guildId:userId" â†’ Wartende mit Namen. */
const waitingEntries = new Map<string, QueueEntry>();

function entryKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/**
 * Registriert ein Mitglied in der Warteschlange. Der RÃ¼ckgabewert ist die
 * Position (1-basiert), die auch im Nickname als "(n) " auftaucht.
 */
export function enqueueWaiting(
  guildId: string,
  userId: string,
  originalNick: string | null,
  originalName: string,
): number {
  const key = entryKey(guildId, userId);
  if (!waitingEntries.has(key)) {
    waitingEntries.set(key, { userId, originalNick, originalName });
  }
  const list = waitingOrder.get(guildId) ?? [];
  if (!list.includes(userId)) list.push(userId);
  waitingOrder.set(guildId, list);
  return list.indexOf(userId) + 1;
}

/**
 * Entfernt ein Mitglied aus der Warteschlange. Gibt zurÃ¼ck, ob es drin war.
 * Die Nummern der Ã¼brigen Wartenden verschieben sich dadurch â€“ wer danach
 * `renumberWaiting` aufruft, bekommt wieder lÃ¼ckenlose Zahlen.
 */
export function dequeueWaiting(guildId: string, userId: string): boolean {
  const key = entryKey(guildId, userId);
  const list = waitingOrder.get(guildId);
  waitingEntries.delete(key);
  if (!list) return false;
  const position = list.indexOf(userId);
  if (position === -1) return false;
  list.splice(position, 1);
  if (list.length === 0) waitingOrder.delete(guildId);
  return true;
}

/** NÃ¤chster Wartender eines Servers, ohne ihn aus der Liste zu nehmen. */
export function peekNextWaiting(guildId: string): QueueEntry | undefined {
  const list = waitingOrder.get(guildId);
  if (!list || list.length === 0) return undefined;
  const entry = waitingEntries.get(entryKey(guildId, list[0]));
  if (!entry) return undefined;
  return entry;
}

/**
 * Erster Wartender, fÃ¼r den `isEligible` true ist â€“ ohne ihn zu entfernen.
 * Damit lÃ¤sst sich ein Mitglied in Abklingzeit Ã¼berspringen, ohne die
 * FIFO-Reihenfolge der Ã¼brigen zu Ã¤ndern.
 */
export function peekFirstEligible(
  guildId: string,
  isEligible: (userId: string) => boolean,
): QueueEntry | undefined {
  const list = waitingOrder.get(guildId);
  if (!list) return undefined;
  for (const userId of list) {
    const entry = waitingEntries.get(entryKey(guildId, userId));
    if (entry && isEligible(userId)) return entry;
  }
  return undefined;
}

/**
 * "guildId:userId" â†’ Zeitstempel, ab dem wieder geprÃ¼ft werden darf.
 * Nach einem endgÃ¼ltig fehlgeschlagenen Check wartet das Mitglied, statt die
 * ganze Schlange mit einem kaputten Mikrofon aufzuhalten.
 */
const cooldowns = new Map<string, number>();

/** Setzt eine Wartezeit fÃ¼r ein Mitglied. */
export function setCooldown(guildId: string, userId: string, ms: number): void {
  cooldowns.set(entryKey(guildId, userId), Date.now() + ms);
}

/** Restzeit in Millisekunden, 0 wenn das Mitglied sofort dran ist. */
export function cooldownRemaining(guildId: string, userId: string): number {
  const until = cooldowns.get(entryKey(guildId, userId));
  if (until === undefined) return 0;
  const left = until - Date.now();
  if (left <= 0) {
    cooldowns.delete(entryKey(guildId, userId));
    return 0;
  }
  return left;
}

/** Hebt eine Wartezeit auf, z. B. nach erfolgreicher PrÃ¼fung. */
export function clearCooldown(guildId: string, userId: string): void {
  cooldowns.delete(entryKey(guildId, userId));
}

/**
 * Setzt die Nicknames aller Wartenden auf ihre aktuelle Position. NÃ¶tig,
 * weil die Nummern nach jedem departures nach vorn rutschen.
 */
export async function renumberWaiting(guild: Guild): Promise<void> {
  const list = waitingOrder.get(guild.id);
  if (!list || list.length === 0) return;
  for (let i = 0; i < list.length; i++) {
    const userId = list[i];
    if (!userId) continue;
    const entry = waitingEntries.get(entryKey(guild.id, userId));
    if (!entry) continue;
    const member = guild.members.cache.get(userId);
    if (!member || member.user.bot) continue;
    const target = `(${i + 1}) ${entry.originalName}`;
    if (member.nickname === target) continue;
    await member.setNickname(target).catch(() => undefined);
  }
}

/** Setzt den Nickname auf "(position) Name". */
export async function applyQueueNickname(
  guild: Guild,
  memberId: string,
  position: number,
): Promise<void> {
  const entry = waitingEntries.get(entryKey(guild.id, memberId));
  if (!entry) return;
  const member = guild.members.cache.get(memberId);
  if (!member || member.user.bot) return;
  const target = `(${position}) ${entry.originalName}`;
  if (member.nickname === target) return;
  await member.setNickname(target).catch(() => undefined);
}

/**
 * Nimmt das "(n) "-PrÃ¤fix wieder vom Nickname. Wird benutzt, sobald das
 * Mitglied den PrÃ¼f-Kanal betritt und in der Ansage mit echtem Namen
 * angesprochen wird.
 */
export async function stripQueueNickname(
  guild: Guild,
  memberId: string,
): Promise<void> {
  const key = entryKey(guild.id, memberId);
  const entry = waitingEntries.get(key);
  const member = guild.members.cache.get(memberId);
  if (!member || !entry) return;
  const target = entry.originalNick;
  if (member.nickname === target) return;
  await member.setNickname(target).catch(() => undefined);
}

/** Name ohne "(n) "-PrÃ¤fix, damit die Zahl nie vorgelesen wird. */
export function spokenName(displayName: string): string {
  return displayName.replace(/^\(\d+\)\s*/, "").trim();
}
