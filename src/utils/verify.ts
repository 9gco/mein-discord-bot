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
import type { Guild, GuildMember } from "discord.js";
import OpusScript from "opusscript";
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
  /** Voice-Kanal, in dem geprüft wird (Standard: VERIFY_CHANNEL_ID). */
  channelId?: string;
  /** Voice-Kanal, in dem Mitglieder zunächst warten (Standard: WAITING_CHANNEL_ID). */
  waitingChannelId?: string;
  /** Rolle, die während der Prüfung Sprechberechtigung gibt. */
  micRoleId: string;
  /** Der Text, den der Bot im Voice-Kanal vorliest. {user} = Name des Nutzers. */
  message: string;
  /** Ansage, wenn das Mikrofon nicht brauchbar ist. */
  micFailedMessage: string;
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
/** Rolle, die einem Mitglied während der Prüfung Sprechberechtigung gibt. */
export const MIC_CHECK_ROLE_ID = "1547675358948753418";

const DEFAULT_CONFIG: VerifyConfig = {
  enabled: true,
  channelId: VERIFY_CHANNEL_ID,
  waitingChannelId: WAITING_CHANNEL_ID,
  micRoleId: MIC_CHECK_ROLE_ID,
  message:
    "Willkommen in der Whitelist, {user}. Schön, dass du den Weg zu uns gefunden hast. " +
    "Ich habe dich hierher in den Prüf-Kanal geholt. Damit wir dich im Voice-Chat gut " +
    "verstehen, machen wir gleich einen kurzen Mikrofon-Check. Sprich nach meiner " +
    "Aufforderung einfach ein paar Sätze, der Rest übernehme ich.",
  micFailedMessage:
    "Prüfe bitte deine Discord-Sende-Einstellung und deine Eingabelautstärke, stelle " +
    "dein Mikrofon ein und komm anschließend noch einmal in den Warteraum.",
  micPassedMessage:
    "Perfekt, {user}, dein Mikrofon funktioniert einwandfrei. Ich schließe die " +
    "Prüfung ab und schalte die Kanäle für dich frei.",
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
    channelId: stored?.channelId || VERIFY_CHANNEL_ID,
    waitingChannelId: stored?.waitingChannelId || WAITING_CHANNEL_ID,
    micRoleId: stored?.micRoleId || MIC_CHECK_ROLE_ID,
    message:
      typeof stored?.message === "string" && stored.message
        ? stored.message
        : DEFAULT_CONFIG.message,
    micFailedMessage:
      typeof stored?.micFailedMessage === "string" && stored.micFailedMessage
        ? stored.micFailedMessage
        : DEFAULT_CONFIG.micFailedMessage,
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

// ---------------------------------------------------------------------------
// Mikrofon-Check
// ---------------------------------------------------------------------------

/** Mindest-Sprechdauer, damit ein Versuch als "geredet" gilt. */
const MIC_MIN_SPEECH_MS = 700;
/** Ab diesem RMS-Pegel gilt ein Frame als "da ist Sprache" (Stille-Rauschen liegt darunter). */
const MIC_SPEECH_FLOOR = 0.004;
/** Mindest-Durchschnittspegel (RMS, 0..1) — darunter gilt das Mikrofon als zu leise. */
const MIC_MIN_LEVEL = 0.012;
/** Wie lange auf Sprache gewartet wird, bevor der Check als "nichts gehört" endet. */
const MIC_MAX_WAIT_MS = 45_000;
/** Opus-Abtastrate und Framegröße für Discord-Voice (20 ms). */
const OPUS_RATE = 48_000;
const OPUS_FRAME_MS = 20;

export interface MicCheckResult {
  /** true = Mikrofon brauchbar, Verifizierung darf weiterlaufen. */
  ok: boolean;
  /** Grund für ein Scheitern, nur gesetzt wenn ok === false. */
  reason?: "no_speech" | "too_quiet" | "error";
  /** Gemessene Sprechzeit in Millisekunden. */
  speechMs: number;
  /** Gemessener mittlerer Pegel (0..1). */
  level: number;
}

/**
 * RMS-Pegel eines Opus-Pakets. Discord liefert Opus, `opusscript` dekodiert zu
 * PCM; daraus wird der mittlere Betrag gebildet. Fehler (z. B. fehlendes
 * WASM) liefern 0, dann greift der Pegel-Check nicht als "leer".
 */
function measureLevel(decoder: OpusScript | undefined, packet: Buffer): number {
  if (!decoder) return 0;
  try {
    const pcm = decoder.decode(packet);
    if (!pcm || pcm.length === 0) return 0;
    let sum = 0;
    let samples = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) {
      const sample = pcm.readInt16LE(i) / 32768;
      sum += sample * sample;
      samples++;
    }
    return samples > 0 ? Math.sqrt(sum / samples) : 0;
  } catch {
    return 0;
  }
}

/**
 * Wartet, bis niemand im Kanal spricht, damit der Bot nicht mitten in einen
 * Satz redet. `graceMs` ist eine kleine Schonzeit nach dem letzten Sprecher,
 * damit Ansagen sich nicht überlappen.
 */
export function waitForSilence(
  connection: VoiceConnection,
  graceMs = 700,
  maxWaitMs = 60_000,
): Promise<void> {
  return new Promise((resolve) => {
    const speaking = connection.receiver.speaking;
    let settled = false;
    let active = 0;
    let graceTimer: NodeJS.Timeout | undefined;
    let hardTimeout: NodeJS.Timeout | undefined;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
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

    // Wer schon spricht, zählt ebenfalls als belegt.
    if (speaking.users.size > 0) active = speaking.users.size;
    startGrace();
  });
}

/**
 * Nimmt die Stimme eines Mitglieds über den Voice-Receiver auf und bewertet,
 * ob das Mikrofon brauchbar ist: es muss hörbar sprechen (Pegel über
 * `MIC_MIN_LEVEL`) und insgesamt mindestens `MIC_MIN_SPEECH_MS` lang reden.
 *
 * Der Check endet nach einer kurzen Stille nach der ersten Sprachphase. Wer
 * gar nichts aufnimmt, wartet bis `MIC_MAX_WAIT_MS` und wird dann als
 * "no_speech" gemeldet.
 */
export function runMicCheck(
  connection: VoiceConnection,
  memberId: string,
): Promise<MicCheckResult> {
  return new Promise((resolve) => {
    let decoder: OpusScript | undefined;
    try {
      decoder = new OpusScript(OPUS_RATE, 1, OpusScript.Application.VOIP);
    } catch (err) {
      logger.warn("Opus-Decoder nicht verfügbar – nur Sprech-Erkennung.", {
        error: err,
      });
      decoder = undefined;
    }

let settled = false;
    /** Frames, in denen wirklich etwas hörbar war (über MIC_SPEECH_FLOOR). */
    let voiceFrames = 0;
    let levelSum = 0;
    /** Fallback ohne Decoder: Sprechzeit über die Speaking-Events. */
    let fallbackSpeechMs = 0;
    let fallbackTimer: NodeJS.Timeout | undefined;
    let silentTimer: NodeJS.Timeout | undefined;
    let hardTimeout: NodeJS.Timeout | undefined;
    /** Zusätzliche Abmeldungen, die beim Beenden des Checks ausgeführt werden. */
    const detachers: Array<() => void> = [];

    const speechMs = (): number =>
      decoder ? voiceFrames * OPUS_FRAME_MS : fallbackSpeechMs;

    const level = (): number => (voiceFrames > 0 ? levelSum / voiceFrames : 0);

    const finish = (outcome: MicCheckResult): void => {
      if (settled) return;
      settled = true;
      if (silentTimer) clearTimeout(silentTimer);
      if (hardTimeout) clearTimeout(hardTimeout);
      if (fallbackTimer) clearInterval(fallbackTimer);
      for (const detach of detachers) {
        try {
          detach();
        } catch {
          // Aufräumen ist bestmöglich.
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
      const ms = speechMs();
      const lvl = level();
      if (ms < MIC_MIN_SPEECH_MS) {
        finish({ ok: false, reason: "no_speech", speechMs: ms, level: lvl });
        return;
      }
      if (decoder && lvl < MIC_MIN_LEVEL) {
        finish({ ok: false, reason: "too_quiet", speechMs: ms, level: lvl });
        return;
      }
      finish({ ok: true, speechMs: ms, level: lvl });
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

    subscription.on("data", (packet: Buffer) => {
      if (settled || packet.length === 0) return;
      const lvl = measureLevel(decoder, packet);
      if (lvl >= MIC_SPEECH_FLOOR) {
        voiceFrames++;
        levelSum += lvl;
        // Erstes Hören beendet das Warten auf eine Maximaldauer.
        if (hardTimeout) clearTimeout(hardTimeout);
      }
      restartSilenceTimer();
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
      finish({ ok: false, reason: "error", speechMs: 0, level: 0 });
    });

    // Ohne Decoder können wir den Pegel nicht messen, aber Discord meldet
    // weiterhin zuverlässig, wann jemand spricht.
    if (!decoder) {
      const speaking = connection.receiver.speaking;
      const onStart = (userId: string): void => {
        if (settled || userId !== memberId) return;
        if (hardTimeout) clearTimeout(hardTimeout);
        if (fallbackTimer) clearInterval(fallbackTimer);
        fallbackTimer = setInterval(() => {
          fallbackSpeechMs += 100;
        }, 100);
        restartSilenceTimer();
      };
      const onEnd = (userId: string): void => {
        if (settled || userId !== memberId) return;
        if (fallbackTimer) clearInterval(fallbackTimer);
        fallbackTimer = undefined;
        restartSilenceTimer();
      };
      speaking.on("start", onStart);
      speaking.on("end", onEnd);
      detachers.push(() => {
        speaking.off("start", onStart);
        speaking.off("end", onEnd);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Warteschlange und Namensnummern
// ---------------------------------------------------------------------------

interface QueueEntry {
  userId: string;
  /** Nickname vor dem Setzen des "(n) "-Präfix. */
  originalNick: string | null;
  originalName: string;
}

/** guildId → Reihenfolge der Wartenden (Join-Reihenfolge). */
const waitingOrder = new Map<string, string[]>();
/** "guildId:userId" → Wartende mit Namen. */
const waitingEntries = new Map<string, QueueEntry>();

function entryKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

/**
 * Registriert ein Mitglied in der Warteschlange. Der Rückgabewert ist die
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
 * Entfernt ein Mitglied aus der Warteschlange. Gibt zurück, ob es drin war.
 * Die Nummern der übrigen Wartenden verschieben sich dadurch – wer danach
 * `renumberWaiting` aufruft, bekommt wieder lückenlose Zahlen.
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

/** Nächster Wartender eines Servers, ohne ihn aus der Liste zu nehmen. */
export function peekNextWaiting(guildId: string): QueueEntry | undefined {
  const list = waitingOrder.get(guildId);
  if (!list || list.length === 0) return undefined;
  const entry = waitingEntries.get(entryKey(guildId, list[0]));
  if (!entry) return undefined;
  return entry;
}

/**
 * Setzt die Nicknames aller Wartenden auf ihre aktuelle Position. Nötig,
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
 * Nimmt das "(n) "-Präfix wieder vom Nickname. Wird benutzt, sobald das
 * Mitglied den Prüf-Kanal betritt und in der Ansage mit echtem Namen
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

/** Name ohne "(n) "-Präfix, damit die Zahl nie vorgelesen wird. */
export function spokenName(displayName: string): string {
  return displayName.replace(/^\(\d+\)\s*/, "").trim();
}
