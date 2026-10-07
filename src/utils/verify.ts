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

// Stelle sicher, dass @discordjs/voice zum Transkodieren von MP3 → Opus
// das gebündelte ffmpeg von ffmpeg-static nutzt.
if (ffmpeg) process.env.FFMPEG_PATH = ffmpeg;

export interface VerifyConfig {
  enabled: boolean;
  /** Voice-Kanal, in dem geprüft wird (Standard: VERIFY_CHANNEL_ID). */
  channelId?: string;
  /** Voice-Kanal, in dem Mitglieder zunächst warten (Standard: WAITING_CHANNEL_ID). */
  waitingChannelId?: string;
/**
 * Altbestand aus früheren Versionen: es gab einmal eine Prüf-Rolle. Wird nicht
 * mehr verwendet, das Sprechrecht hängt jetzt direkt am Mitglied. Nur noch
 * im Typ, damit gespeicherte Konfigurationen weiterhin geladen werden können.
 */
  micRoleId?: string;
  /** Der Text, den der Bot im Voice-Kanal vorliest. {user} = Name des Nutzers. */
  message: string;
  /** Ansage, wenn das Mikrofon nicht brauchbar ist. */
  micFailedMessage: string;
  /**
   * Ansage, mit der das Sprechrecht freigeschaltet wird. Erst danach darf das
   * Mitglied im Prüf-Kanal reden.
   */
  speakNowMessage: string;
  /** Ansage, wenn der Mikrofon-Check erfolgreich war. */
  micPassedMessage: string;
  /** Edge-TTS-Stimme (ShortName), z. B. "de-DE-KatjaNeural". */
  voice: string;
  /** Rollen, die nach der Ansage vergeben werden. */
  roles: string[];
  /**
   * Version der Ansagetexte. Wird hochgezählt, wenn die Standardtexte neu
   * geschrieben werden – gespeicherte Texte aus älteren Versionen werden dann
   * durch die neuen ersetzt, statt weiter vorgelesen zu werden.
   */
  textsVersion: number;
}

/** Kanal, in dem Mitglieder warten, bevor sie gezogen werden. */
export const WAITING_CHANNEL_ID = "1547675527844864020";
/** Kanal, in dem Ansage und Mikrofon-Check laufen. */
export const VERIFY_CHANNEL_ID = "1547676303149244508";

/**
 * Kurze Schonzeit, nachdem das Mitglied im Prüf-Kanal angekommen ist. Ohne sie
 * fehlen vom Bot-Audio die ersten Pakete – der Start der Ansage ginge
 * verloren.
 */
const MEMBER_SETTLE_MS = 700;
/**
 * Rolle, die dauerhaft an geprüfte Mitglieder vergeben wird. Sie bleibt
 * dauerhaft und wird vom Bot nicht angefasst.
 *
 * Für den Zugang zum Prüf-Kanal ist sie nicht zuständig: `@everyone` hat dort
 * weder "Kanäle ansehen" noch "Verbinden", damit sich niemand selbst eintragen
 * kann. Der Bot zieht seine Wartenden mit "Move Members" trotzdem hinein, und
 * "Senden" steht offen, damit sie dort reden können.
 */
export const MIC_CHECK_ROLE_ID = "1547675358948753418";
/**
 * Rolle, die ein Mitglied nach bestandenem Mikrofon-Check bekommt. Nur diese
 * Rolle gilt als "bereits verifiziert" – `MIC_CHECK_ROLE_ID` hat laut Server-
 * Konfiguration jedes Mitglied und taugt deshalb nicht als Nachweis.
 */
export const VERIFIED_ROLE_ID = "1547675350887178240";

/**
 * Standardtexte für die Ansagen.
 *
 * Kontext: Der Bot ist die Whitelist eines großen FiveM-RP-Servers. Der Ton
 * ist deshalb freundlich, aber dienstleistend - ein Moderator im Voice-Chat,
 * kein Assistent und kein Kumpel. Daraus folgt:
 *
 * 1. Kein Kommentar über die Technik dahinter. "Ich hole dich kurz hier rüber"
 *    oder "Ich schalte dich jetzt frei" sagt ein Mensch nicht, und man hört
 *    sofort, dass es synthetisch ist.
 * 2. Keine Fachbegriffe ohne Nutzen. Statt "es liegen 0,8 Sekunden Sprechzeit
 *    vor" besser "der Test war etwas zu kurz" - die Zahl musste niemand.
 * 3. "Voice-Chat" und "Mikrofon" statt "Channel" und "Check". Für einen
 *    FiveM-Server wäre "Channel" das falsche Wort, das sind Discord-Begriffe.
 * 4. Eine Ansage ist ein durchgehender Satzgefug, keine Liste. Die Pausen
 *    entstehen in der Stimme, nicht zwischen abgespielten Dateien.
 * 5. Es soll klingen wie ein Mensch im Voice-Chat. Kurze alltägliche Sätze,
 *    zugehört und mitgedacht - kein Ton auf den man "das ist eine KI" denkt.
 *    Nichts davon: "Ausgezeichnet", "leider ein technischer Fehler aufgetreten",
 *    "ich höre zu", "erzähl mir wie dein Tag so war oder was dir sonst noch
 *    einfällt" - das ist der bekannteste Chatbot-Einstieg überhaupt. Ein Mensch
 *    sagt "Top das kommt klar an", "zähl einfach mal bis zehn" oder "hoppla da
 *    ist etwas schiefgelaufen".
 * 6. Ohne Kommas, wie alle anderen Texte im Bot auch.
 * 7. Nur Wörter, die die Stimme sauber trifft. Umgangssprache wie "ruckzuck"
 *    oder "guck" kommt als Kauderwelsch heraus, und ein Imperativ wie "Red
 *    ein paar Sätze" sieht für die Stimme aus wie das englische Wort. Im
 *    Zweifel das Wort nehmen, das man auch so schreibt wie man es hört.
 * 8. Jeder Text in mehreren Varianten, getrennt durch `---`. Ein Mensch sagt
 *    dieselbe Ansage nie zweimal wörtlich gleich – wer dreimal scheitert soll
 *    auch dreimal etwas anderes hören. Siehe `VARIANT_SEPARATOR`.
 */
/**
 * Trenner zwischen zwei Varianten desselben Textes. Bei jeder Ansage wird
 * zufällig eine ausgewählt – wer mehrfach scheitert soll nicht immer denselben
 * Satz hören. Texte ohne Trenner bleiben unverändert.
 */
export const VARIANT_SEPARATOR = "\n---\n";

/** Zufälliger Eintrag aus einer Liste. */
export function pickRandom(options: readonly string[]): string {
  const index = Math.floor(Math.random() * options.length);
  return options[index] ?? options[0] ?? "";
}

/** Wählt eine der durch `VARIANT_SEPARATOR` getrennten Varianten. */
export function pickVariant(text: string): string {
  if (!text.includes(VARIANT_SEPARATOR)) return text;
  return pickRandom(text.split(VARIANT_SEPARATOR).map((v) => v.trim()));
}

/** Aktuelle Fassung der Standardtexte; siehe `textsVersion`. */
const TEXTS_VERSION = 10;

const DEFAULT_CONFIG: VerifyConfig = {
  enabled: true,
  channelId: VERIFY_CHANNEL_ID,
  waitingChannelId: WAITING_CHANNEL_ID,
  message: [
    "Hey {user} schön dass du da bist. Kurze Mikrofonprobe damit dich alle gut verstehen. Danach bist du schon durch.",
    "Hallo {user} willkommen. Wir machen nur ganz kurz die Mikrofonprobe dann hast du deine Freigabe.",
    "So {user} gut dass du da bist. Ein paar Wörter ins Mikro und dann ist alles erledigt.",
  ].join(VARIANT_SEPARATOR),
  speakNowMessage: [
    "So {user} du bist dran. Zähl einfach mal laut bis zehn damit ich dich höre.",
    "{user} nimm dir ruhig Zeit. Sag einfach etwas in dein Mikro egal worum es geht.",
    "So {user} los geht es. Ein paar Sätze reichen schon dann können wir weiter machen.",
  ].join(VARIANT_SEPARATOR),
  micFailedMessage: [
    "Schau kurz in die Discord Einstellungen welches Mikrofon dort ausgewählt ist. Meist liegt es genau daran. Danach versuchen wir es noch einmal.",
    "Kleiner Tipp: In den Discord Einstellungen unter Ton sollte dein Mikrofon ausgewählt sein. Ist das erledigt versuchen wir es einfach noch einmal.",
    "Bei dir kam gerade nichts an. Schau in Discord unter Ton ob das richtige Mikrofon ausgewählt ist dann machen wir hier weiter.",
  ].join(VARIANT_SEPARATOR),
  micPassedMessage: [
    "Perfekt {user} dich höre ich glasklar. Damit bist du freigeschaltet. Willkommen im Spiel und viel Spaß.",
    "Super {user} jetzt kommt alles sauber an. Du hast es geschafft und bist durch. Willkommen auf dem Server.",
    "Sehr gut {user} so hört sich das gut an. Du bist verifiziert und kannst loslegen. Bis gleich im Spiel.",
  ].join(VARIANT_SEPARATOR),
  voice: "de-DE-SeraphinaMultilingualNeural",
  roles: [],
  textsVersion: TEXTS_VERSION,
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
    label: "Deutsch – Seraphina (weiblich multilingual)",
  },
  { name: "de-DE-ConradNeural", label: "Deutsch – Conrad (männlich)" },
  {
    name: "de-DE-FlorianMultilingualNeural",
    label: "Deutsch – Florian (männlich multilingual)",
  },
  { name: "de-DE-KillianNeural", label: "Deutsch – Killian (männlich jung)" },
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

/**
 * Erkennungszeichen für doppelt kodierten Text: Umlaute und Bindestriche
 * stehen dann als zwei bis drei Zeichen hintereinander (z. B. der Umlaut-o
 * als Buchstabe gefolgt von einem Paragraphenzeichen).
 */
const MOJIBAKE_MARKER = /[\u00C2\u00C3\u00E2\u00E3\u00F0\u00FE]/;

/**
 * Repariert Text, der als UTF-8 gelesen und als Windows-1252 wieder
 * geschrieben wurde – Umlaute und Bindestriche stehen dann als mehrere
 * Zeichen da. Solche Texte können in bereits gespeicherten Ansagen stecken
 * und würden sonst auch noch vorgelesen.
 *
 * Der Text wird zurück nach CP1252 zerlegt und als UTF-8 gelesen. Nur wenn
 * das Ergebnis gültiges UTF-8 ist, wird es verwendet – sonst bleibt der
 * Originaltext stehen.
 */
export function repairMojibake(text: string): string {
  if (!MOJIBAKE_MARKER.test(text)) return text;

  // CP1255-Byte → Zeichen, umgekehrte Richtung für die Reparatur.
  const decoder = new TextDecoder("windows-1252");
  const toByte = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    const ch = decoder.decode(new Uint8Array([b]));
    if (ch.length === 1 && !toByte.has(ch)) toByte.set(ch, b);
  }

  const bytes: number[] = [];
  for (const ch of text) {
    const b = toByte.get(ch);
    // Unbekanntes Zeichen → keine sichere Reparatur.
    if (b === undefined) return text;
    bytes.push(b);
  }

  try {
    const repaired = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes),
    );
    return repaired;
  } catch {
    return text;
  }
}

/** Nimmt einen gespeicherten Text, repariert ihn und fällt sonst auf den Standard zurück. */
function storedText(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value) return fallback;
  return repairMojibake(value);
}

function normalizeConfig(stored: Partial<VerifyConfig> | undefined): VerifyConfig {
  // Alt-Konfigurationen hatten "lang" (Sprachcode) bzw. "voice" (StreamElements).
  const legacy = stored as (VerifyConfig & { lang?: string }) | undefined;
  const storedVoice =
    typeof legacy?.voice === "string" && legacy.voice.includes("-")
      ? legacy.voice
      : legacy?.lang
        ? LEGACY_LANG_TO_VOICE[legacy.lang]
        : undefined;

  // Gespeicherte Texte aus einer älteren Fassung würden sonst weiter vorgelesen.
  // Sie werden durch die aktuellen Standardtexte ersetzt – Kanäle und Rollen
  // bleiben unangetastet. Die Stimme wandert mit: die alte Voreinstellung war
  // bewusst gewählt worden, also gehört sie zum selben Neustand. Wer später
  // eine andere Stimme wählt, bleibt dabei, weil danach kein Wechsel mehr
  // stattfindet.
  const useNewDefaults = stored?.textsVersion !== TEXTS_VERSION;

  return {
    enabled: stored?.enabled ?? DEFAULT_CONFIG.enabled,
    channelId: stored?.channelId || VERIFY_CHANNEL_ID,
    waitingChannelId: stored?.waitingChannelId || WAITING_CHANNEL_ID,

    message: useNewDefaults
      ? DEFAULT_CONFIG.message
      : storedText(stored?.message, DEFAULT_CONFIG.message),
    micFailedMessage: useNewDefaults
      ? DEFAULT_CONFIG.micFailedMessage
      : storedText(stored?.micFailedMessage, DEFAULT_CONFIG.micFailedMessage),
    speakNowMessage: useNewDefaults
      ? DEFAULT_CONFIG.speakNowMessage
      : storedText(stored?.speakNowMessage, DEFAULT_CONFIG.speakNowMessage),
    micPassedMessage: useNewDefaults
      ? DEFAULT_CONFIG.micPassedMessage
      : storedText(stored?.micPassedMessage, DEFAULT_CONFIG.micPassedMessage),
    voice: useNewDefaults ? DEFAULT_CONFIG.voice : storedVoice || DEFAULT_CONFIG.voice,
    roles: Array.isArray(stored?.roles) ? stored.roles : [],
    textsVersion: TEXTS_VERSION,
  };
}

export async function getVerifyConfig(guildId: string): Promise<VerifyConfig> {
  const cached = configCache.get(guildId);
  if (cached) return cached;
  const stored = await verifyStore.read(guildId);
  const cfg = normalizeConfig(stored);
  configCache.set(guildId, cfg);
  // Die neuen Texte einmalig festschreiben, damit die Ersetzung nicht bei
  // jedem Start erneut durchläuft.
  if (stored?.textsVersion !== TEXTS_VERSION) {
    await verifyStore.write(guildId, cfg).catch(() => undefined);
  }
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
  // Beim Speichern gleich mitreparieren, damit kaputte Zeichen aus einer
  // fehlerhaften Eingabe nicht dauerhaft in der Konfiguration landen.
  const clean: VerifyConfig = {
    ...cfg,
    message: repairMojibake(cfg.message),
    micFailedMessage: repairMojibake(cfg.micFailedMessage),
    speakNowMessage: repairMojibake(cfg.speakNowMessage),
    micPassedMessage: repairMojibake(cfg.micPassedMessage),
  };
  configCache.set(guildId, clean);
  await verifyStore.write(guildId, clean);
}

/**
 * Erzeugt TTS-Audio (MP3) über den kostenlosen Microsoft Edge-Sprachdienst
 * (kein API-Key nötig, läuft server-seitig). Ergebnisse werden zwischen-
 * gespeichert, damit dieselbe Ansage nicht erneut synthetisiert wird.
 */
const TTS_CACHE_LIMIT = 40;
const ttsCache = new Map<string, Buffer>();

/**
 * Sprechtempo und Betonung fuer die Ansagen. Beides ist ueber die Umgebung
 * anpassbar, ohne Code zu aendern: TTS_RATE=+20% macht schneller,
 * TTS_RATE=-20% langsamer, TTS_PITCH=+5Hz hoeher.
 *
 * Tempo und Tonhöhe bleiben unveraendert. Jede Verschiebung davon klingt
 * auffällig nach Roboter - die Ansagen waren dadurch langsam und künstlich.
 * Wer es doch langsamer braucht, setzt TTS_RATE=-10%.
 */
const TTS_RATE = process.env["TTS_RATE"]?.trim() || "+0%";
const TTS_PITCH = process.env["TTS_PITCH"]?.trim() || "+0Hz";

export async function fetchTtsAudio(text: string, voice: string): Promise<Buffer> {
  // Tempo, Tonhöhe und Text gehören in den Cache-Schlüssel: sonst käme nach
  // einer Änderung der alte Ton aus dem Cache.
  const cacheKey = `${voice}::${TTS_RATE}::${TTS_PITCH}::${text}`;
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

/**
 * Zerlegt eine Ansage an den Satzzeichen.
 */
export function splitSentences(text: string): string[] {
  const sentences = text
    .split(/(?<=[.!?…])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return sentences.length > 0 ? sentences : [text];
}

/**
 * Teilt eine Ansage nur dann, wenn sie wirklich zu lang für einen einzigen
 * Spruch ist.
 *
 * Jeder Satz einzeln zu synthetisieren und mit Pause dazwischen abzuspielen
 * klang nach Stottern: die Stimme fing alle zwei bis fünf Sekunden neu an und
 * der ganze Durchlauf wirkte wie eine Ansage aus einem Lautsprecher. Deshalb
 * bekommen alle realistischen Ansagen einen einzigen Auftrag - Betonung und
 * Pausen entstehen dann in der Stimme selbst, wo sie hingehören, statt an den
 * Nahtstellen zwischen zwei Dateien.
 *
 * Getrennt wird nur, wenn ein Text wirklich ungewöhnlich lang ist, und
 * ausschließlich an Satzgrenzen: mitten im Satz zu schneiden würde die Betonung
 * zerhacken. Selbst dann gibt es keine eingebaute Pause.
 *
 * Rund 900 Zeichen sind etwa anderthalb Minuten Sprache - die Grenze wird bei
 * normalen Ansagen nie erreicht und ist nur die Sicherung gegen einen
 * irrsinnig langen Text aus einer alten gespeicherten Konfiguration.
 */
const CHUNK_MAX_CHARS = 900;

export function chunkAnnouncement(text: string): string[] {
  if (text.length <= CHUNK_MAX_CHARS) return [text];

  const chunks: string[] = [];
  let sentences: string[] = [];
  let length = 0;

  const flush = (): void => {
    if (sentences.length === 0) return;
    chunks.push(sentences.join(" "));
    sentences = [];
    length = 0;
  };

  for (const sentence of splitSentences(text)) {
    if (length > 0 && length + sentence.length + 1 > CHUNK_MAX_CHARS) flush();
    sentences.push(sentence);
    length += sentence.length + 1;
  }
  flush();

  return chunks.length > 0 ? chunks : [text];
}

/**
 * Synthetisiert eine Ansage. Bei normalen Texten kommt genau ein Stück zurück.
 * Mehrere Stücke gibt es nur bei außergewöhnlich langen Texten, und auch dann
 * gibt `fetchTtsChunks` sie ohne Pause nacheinander ab.
 */
export async function fetchTtsChunks(text: string, voice: string): Promise<Buffer[]> {
  const buffers: Buffer[] = [];
  // Bewusst nacheinander: jedes Stück öffnet eine eigene Verbindung zum
  // Sprachdienst, mehrere parallel wären dort unhöflich und würden gern
  // gedrosselt.
  for (const chunk of chunkAnnouncement(text)) {
    buffers.push(await fetchTtsAudio(chunk, voice));
  }
  return buffers;
}

async function synthesizeSpeech(text: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text, {
      // Normal, unverschoben. Ansagen im Kanal klingen nur dann wie ein
      // Gespräch, wenn sie nicht absichtlich gebremst oder in der Tonhöhe
      // verfremdet werden. Ueberschreiben mit TTS_RATE / TTS_PITCH.
      rate: TTS_RATE,
      pitch: TTS_PITCH,
    });
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
 * Wird geworfen, wenn ein Prüf-Durchlauf abbricht, weil das Mitglied den
 * Kanal vorher verlassen hat. Kein Fehlerfall, sondern normales Ende.
 */
export class VerifyAbortedError extends Error {
  constructor(reason = "Prüfung abgebrochen") {
    super(reason);
    this.name = "VerifyAbortedError";
  }
}

/** Prüft, ob ein Durchlauf noch laufen darf, und wirft sonst. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new VerifyAbortedError();
}

/** `setTimeout`, das bei Abbruch sofort wieder zurückkehrt. */
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

/** Registriert einen Abbruch-Handler und liefert die Aufräumfunktion. */
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
 * Wartet, bis ein Mitglied wirklich im Voice-Kanal angekommen ist und den
 * Audio-Stream des Bots auch empfangen kann.
 *
 * Nach `setChannel` hat Discord den Move nur bestätigt – der Client des
 * Mitglieds muss seine Voice-Verbindung erst noch aufbauen. Wer die Ansage
 * sofort loslässt, redet der Bot in einen Kanal, in dem noch niemand zuhört.
 * `sessionId` ist erst gesetzt, wenn der Handshake des Clients abgeschlossen
 * ist, also ab dem Moment, an dem Audio tatsächlich ankommt.
 *
 * Gibt `false` zurück, wenn das Mitglied in der Zeit nicht auftaucht – dann
 * darf der Bot besser schweigen als in einen leeren Kanal reden.
 */
export async function waitForMemberInChannel(
  guild: Guild,
  memberId: string,
  channelId: string,
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal?.aborted) return false;
    if (!isMemberInChannel(guild, memberId, channelId)) {
      // Mitglied hat den Server verlassen – nicht weiter warten.
      if (!guild.members.cache.has(memberId)) return false;
      await abortableDelay(250, signal).catch(() => undefined);
      continue;
    }

    // Kanal stimmt, aber der Client hat den Voice-Handshake noch nicht
    // abgeschlossen: `sessionId` fehlt, solange er "verbindet".
    const state = guild.voiceStates.cache.get(memberId);
    if (state?.sessionId) {
      // Einen Moment Luft, damit die ersten Audio-Pakete eintreffen.
      await abortableDelay(MEMBER_SETTLE_MS, signal).catch(() => undefined);
      return !signal?.aborted;
    }

    await abortableDelay(250, signal).catch(() => undefined);
  }

  logger.warn("Mitglied war nicht rechtzeitig im Prüf-Kanal – Ansage entfällt.", {
    guildId: guild.id,
    userId: memberId,
    channelId,
    timeoutMs,
  });
  return false;
}

/**
 * Stimmt das Mitglied gerade mit dem Voice-Kanal überein? Der Gateway-State
 * ist die verlässlichere Quelle als `member.voice`, weil er auch nach einem
 * Move sofort den neuen Kanal zeigt.
 */
export function isMemberInChannel(
  guild: Guild,
  memberId: string,
  channelId: string,
): boolean {
  const state = guild.voiceStates.cache.get(memberId);
  if (state) return state.channelId === channelId;
  return guild.members.cache.get(memberId)?.voice.channelId === channelId;
}

/**
 * Liest die aktuellen Kanalrechte eines Mitglieds im Prüf-Kanal und
 * protokolliert sie. Der Bot ändert an den Rechten nichts mehr – die
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

  // Rollen, die im Kanal "Senden: aus" haben und damit das Mitglied stumm
  // halten. Ein Rollen-Override gewinnt gegen den Rest.
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

  logger.info("Kanalrechte (nur gelesen, nicht geändert).", {
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
 * Spielt einen Audio-Puffer über der bestehenden Verbindung ab und wartet bis
 * zum Ende. Der Notausstieg richtet sich nach der Länge des Audios, damit
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

    // Das MP3 kommt mit ca. 48 kbit/s (~6 kB/s). Bewusst konservativ schätzen
    // (5 kB/s) und großzügig Puffer drauflegen.
    const estimatedMs = Math.ceil((buffer.length / 5000) * 1000);
    timer = setTimeout(
      () => finish(true),
      estimatedMs + 20_000,
    );

    player.once(AudioPlayerStatus.Idle, () => finish(false));
    player.once("error", (err: Error) => {
      logger.error("Audio-Player-Fehler während der Verifizierung.", {
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
 * Spielt mehrere Audiodateien hintereinander ab.
 *
 * Der Abstand ist bewusst null: eine eingebaute Pause zwischen zwei Stücken
 * hört man sofort, weil die Stimme an der Nahtstelle neu ansetzt. Stattdessen
 * entsteht die Pause innerhalb der Ansage - die Stimme atmet von selbst. Bei
 * normalen Texten kommt ohnehin nur ein einziges Stück hier an.
 */
export async function playBuffers(
  connection: VoiceConnection,
  buffers: readonly Buffer[],
  signal?: AbortSignal,
  gapMs = 0,
): Promise<void> {
  for (const [index, buffer] of buffers.entries()) {
    throwIfAborted(signal);
    await playBuffer(connection, buffer, signal);
    if (gapMs > 0 && index < buffers.length - 1) {
      // Ein Abbruch beim Warten soll den Abbruch weiterreichen, nicht die
      // Ansage beenden - das übernimmt throwIfAborted im nächsten Durchlauf.
      await abortableDelay(gapMs, signal).catch(() => undefined);
    }
  }
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
const MIC_MIN_SPEECH_MS = 800;
/** Ab diesem RMS-Pegel gilt ein Frame als "da ist Sprache" (Stille-Rauschen liegt darunter). */
const MIC_SPEECH_FLOOR = 0.006;
/** Mindest-Durchschnittspegel (RMS, 0..1) — darunter gilt das Mikrofon als zu leise. */
const MIC_MIN_LEVEL = 0.03;
/** Ab diesem Spitzenwert gilt das Signal als übersteuert. */
const MIC_CLIP_PEAK = 0.97;
/** Sprache muss mindestens so viel lauter sein wie der Rauschboden (Faktor ≈ +12 dB). */
const MIC_MIN_SNR = 4;
/** Wie viele Stille-Frames wir mindestens brauchen, um den Rauschboden zu schätzen. */
const MIC_MIN_NOISE_FRAMES = 5;
/**
 * Wie lange auf den ersten Ton gewartet wird, bevor der Check als "nichts
 * gehört" endet. Großzügig, weil der erste Ton erst nach Ansage und
 * Verbindungsaufbau kommt – wer hier knapp scheitert, wird sofort rausgeworfen.
 */
const MIC_MAX_WAIT_MS = 90_000;
/**
 * Wie lange der Check nach dem ersten Ton noch laufen darf. Wer erst spät
 * anfängt zu reden, bekommt dadurch eine faire Länge, ohne die Schlange
 * unbegrenzt zu blockieren.
 */
const MIC_AFTER_FIRST_TONE_MS = 25_000;
/**
 * Wie lange vor dem Ende des Zeitfensters noch weiter zugehört wird, obwohl
 * noch zu wenig Sprache da ist. Solange mehr Zeit bleibt, wird nicht
 * ausgewertet – eine kurze Pause mitten im Satz darf kein Fehlschlag sein.
 */
const MIC_SHORT_GIVEUP_MS = 15_000;
/** Stille, nach der ausgewertet wird, sobald genug Sprache aufgezeichnet wurde. */
const MIC_EVAL_SILENCE_MS = 1_500;
/**
 * EndBehavior des Abonnements: nach so viel Stille gilt der Stream als beendet.
 * Das ist bewusst kurz – eine Denkpause soll den Aufnahme-Stream nicht
 * beenden, das Neuholen übernimmt `attachSubscription`.
 */
const MIC_STREAM_END_SILENCE_MS = 400;
/** Opus-Abtastrate und Framegröße für Discord-Voice (20 ms). */
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
  /** Grund für ein Scheitern, nur gesetzt wenn ok === false. */
  reason?: MicCheckReason;
  /** Gemessene Sprechzeit in Millisekunden. */
  speechMs: number;
  /** Gemessener mittlerer Sprechpegel (0..1). */
  level: number;
  /** Höchster Spitzenwert im Signal (0..1), 1 = voll aufgedreht. */
  peak: number;
  /** Verhältnis Sprechpegel zu Rauschboden. */
  snr: number;
}

/** Rohwerte, die `judgeMicMeasurement` bewertet. */
export interface MicMeasurement {
  /** Gemessene Sprechzeit in Millisekunden. */
  speechMs: number;
  /** Mittlerer Pegel der Sprachframes (0..1). */
  level: number;
  /** Höchster Spitzenwert der Sprachframes (0..1). */
  peak: number;
  /** Verhältnis Sprechpegel zu Rauschboden, 0 wenn nicht schätzbar. */
  snr: number;
  /** true, wenn der Rauschboden aus genug Stille-Frames geschätzt wurde. */
  noiseKnown: boolean;
  /** false, wenn ohne Opus-Decoder nur die Sprechdauer gemessen wurde. */
  hasLevels: boolean;
}

/**
 * Bewertet eine Messung. Reihenfolge ist bewusst: erst muss überhaupt etwas
 * Brauchbares angekommen sein, danach erst Qualitätskriterien – sonst würde ein
 * stummes Mikrofon als "übersteuert" gemeldet.
 *
 * Reihenfolge: kein Ton → zu kurz → keine Pegeldaten → übersteuert →
 * zu leise → zu verrauscht → bestanden.
 */
export function judgeMicMeasurement(
  m: MicMeasurement,
): MicCheckReason | "ok" {
  if (m.speechMs === 0) return "no_speech";
  if (m.speechMs < MIC_MIN_SPEECH_MS) return "too_short";
  // Ohne Decoder gibt es keine Pegelmessung – dann zählt nur die Sprechdauer.
  if (!m.hasLevels) return "ok";
  if (m.peak >= MIC_CLIP_PEAK) return "clipping";
  if (m.level < MIC_MIN_LEVEL) return "too_quiet";
  if (m.noiseKnown && m.snr < MIC_MIN_SNR) return "noisy";
  return "ok";
}

/** Pegel eines Opus-Pakets: RMS (Lautstärke) und Spitzenwert (Clipping). */
interface FrameLevel {
  /** Mittlerer Betrag des Signals, 0..1. */
  rms: number;
  /** Größter Einzelwert, 0..1. Nahe 1 heißt übersteuert. */
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
 * damit Ansagen sich nicht überlappen.
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

    // Wer schon spricht, zählt ebenfalls als belegt.
    if (speaking.users.size > 0) active = speaking.users.size;
    startGrace();
  });
}

/**
 * Nimmt die Stimme eines Mitglieds über den Voice-Receiver auf und bewertet,
 * ob das Mikrofon brauchbar ist. Geprüft wird in dieser Reihenfolge:
 *
 * 1. `no_speech`  – bis zum Ende des Zeitfensters kam kein verwertbarer Ton
 * 2. `too_short`  – zu wenig Sprechzeit zum Beurteilen
 * 3. `clipping`   – Signal übersteuert (Gain zu hoch)
 * 4. `too_quiet`  – Sprechpegel unter `MIC_MIN_LEVEL`
 * 5. `noisy`      – Sprache hebt sich kaum vom Rauschboden ab
 *
 * Der Check endet nach einer kurzen Stille nach der Sprachphase. Wichtig für
 * die Fairness: Eine kurze Pause mitten im Satz beendet den Check *nicht*.
 * Discord liefert Streams packetweise; eine Denkpause von 400 ms wäre sonst
 * schon ein Fehlschlag. Stattdessen wird neu abonniert und weiter zugehört,
 * bis entweder genug Sprache da ist oder das Zeitfenster abläuft.
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
      logger.warn("Opus-Decoder nicht verfügbar – nur Sprech-Erkennung.", {
        error: err,
      });
      decoder = undefined;
    }

    let settled = false;
    /** Frames, die als Sprache gewertet wurden – Pegelsumme und Spitzenwert. */
    let voiceFrames = 0;
    let levelSum = 0;
    /** Höchster Spitzenwert über alle Sprachframes – für die Clipping-Prüfung. */
    let peakMax = 0;
    /** Frames, die als Rauschen gewertet wurden – Grundlage des Rauschbodens. */
    let noiseFrames = 0;
    let noiseSum = 0;
    /** Alle Frame-Pegel, für die Neuberechnung, falls die Speaking-Events fehlen. */
    const frameLevels: number[] = [];
    const framePeaks: number[] = [];
    /** Discord meldet zuverlässig, wann das Mitglied wirklich sendet. */
    let isSpeaking = false;
    let sawSpeakingEvent = false;
    /** Zeitpunkt des ersten verwertbaren Tons – ab dem läuft die kürzere Frist. */
    let firstToneAt: number | null = null;
    /** Start des Checks – Grundlage für das Zeitfenster ohne ersten Ton. */
    const startedAt = Date.now();
    let silentTimer: NodeJS.Timeout | undefined;
    let hardTimeout: NodeJS.Timeout | undefined;
    /** Aktueller Stream – wird nach jeder Pause neu abonniert. */
    let subscription: ReturnType<VoiceConnection["receiver"]["subscribe"]> | undefined;
    /** Hat Discord den aktuellen Stream nach Stille beendet? */
    let streamEnded = false;
    /** Zusätzliche Abmeldungen, die beim Beenden des Checks ausgeführt werden. */
    const detachers: Array<() => void> = [];

    const speechMs = (): number => voiceFrames * OPUS_FRAME_MS;

    const level = (): number => (voiceFrames > 0 ? levelSum / voiceFrames : 0);

    const snr = (): number => {
      if (noiseFrames < MIC_MIN_NOISE_FRAMES || voiceFrames === 0) return 0;
      const noise = noiseSum / noiseFrames;
      // Rauschboden nahe 0 → Verhältnis ist unendlich groß, das ist in Ordnung.
      if (noise <= 0) return Number.POSITIVE_INFINITY;
      return level() / noise;
    };

    /**
     * Ohne Speaking-Events lässt sich Sprache nicht von dauerhaftem
     * Hintergrundrauschen trennen. In dem Fall wird ersatzweise am Pegel
     * unterschieden – ungenauer, aber besser als ein Fehlschlag für alle.
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
          // Aufräumen ist bestmöglich.
        }
      }
      try {
        subscription?.destroy();
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
      // Speaking-Events vorhanden? Wenn nicht, auf reine Pegelbewertung zurückfallen.
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

    /** Setzt den Timer, nach dessen Ablauf über eine Stillepause entschieden wird. */
    const armEvaluation = (delayMs: number): void => {
      if (settled) return;
      if (silentTimer) clearTimeout(silentTimer);
      silentTimer = setTimeout(onSilenceExpired, delayMs);
    };

    /**
     * Nach einer Stillepause. Nur auswerten, wenn wirklich genug Sprache
     * aufgezeichnet wurde oder das Zeitfenster ohnehin gleich abläuft –
     * sonst wird der Stream neu abonniert und weiter zugehört.
     */
    function onSilenceExpired(): void {
      if (settled) return;
      if (speechMs() >= MIC_MIN_SPEECH_MS) {
        evaluate();
        return;
      }
      // Zu wenig Sprache für eine Bewertung. Nur auswerten, wenn die Zeit
      // ohnehin abläuft, sonst weiterhören – sonst wäre eine kurze Pause
      // mitten im Satz ein Fehlschlag.
      if (
        firstToneAt !== null &&
        Date.now() - firstToneAt >= MIC_SHORT_GIVEUP_MS
      ) {
        evaluate();
        return;
      }
      if (Date.now() - startedAt >= MIC_MAX_WAIT_MS - MIC_SHORT_GIVEUP_MS) {
        evaluate();
        return;
      }
      // Nur neu abonnieren, wenn Discord den Stream wirklich beendet hat.
      // Ein noch laufender Stream wird nicht angefasst – sonst ginge genau
      // der Anfang des nächsten Satzes verloren.
      if (streamEnded) attachSubscription();
    }

    /**
     * Erster wirklich verwertbarer Ton. Ab hier läuft nur noch das kürzere
     * Fenster – vorher wird großzügig gewartet, weil der erste Satz nach
     * Ansage und Verbindungsaufbau kommt.
     */
    const noteFirstTone = (): void => {
      if (firstToneAt !== null) return;
      firstToneAt = Date.now();
      if (hardTimeout) clearTimeout(hardTimeout);
      hardTimeout = setTimeout(
        () => evaluate(),
        Math.max(
          MIC_EVAL_SILENCE_MS,
          Math.min(
            MIC_AFTER_FIRST_TONE_MS,
            MIC_MAX_WAIT_MS - (Date.now() - startedAt),
          ),
        ),
      );
    };

    /**
     * Abonniert den Stimme-Stream des Mitglieds neu. Discord beendet Streams
     * nach kurzer Stille automatisch; ohne Neuabonnierung würde der Rest des
     * Satzes fehlen und der Check zu früh auswerten.
     */
    const attachSubscription = (): void => {
      if (settled) return;
      try {
        subscription?.destroy();
      } catch {
        // Alter Stream war schon beendet.
      }
      streamEnded = false;
      subscription = connection.receiver.subscribe(memberId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: MIC_STREAM_END_SILENCE_MS,
        },
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
          // Erster verwertbarer Ton: ab jetzt läuft die kürzere Frist.
          noteFirstTone();
        } else {
          noiseFrames++;
          noiseSum += rms;
        }

        // Solange gesendet wird, läuft die Zeit weiter.
        if (isSpeaking) armEvaluation(MIC_EVAL_SILENCE_MS);
      });

      subscription.once("end", () => {
        if (settled) return;
        streamEnded = true;
        // Stream-Ende heißt nur, dass kurz niemand gesendet hat. Die Pause
        // abwarten und dann entscheiden, nicht sofort auswerten.
        armEvaluation(MIC_EVAL_SILENCE_MS);
      });

      subscription.once("error", (err: Error) => {
        logger.error("Fehler beim Mikrofon-Check.", {
          userId: memberId,
          error: err,
        });
        finish({ ok: false, reason: "error", speechMs: 0, level: 0, peak: 0, snr: 0 });
      });
    };

    attachSubscription();

    // Zeitfenster: erst auf den ersten Ton warten, danach nur noch
    // `MIC_AFTER_FIRST_TONE_MS`. Wer gar nicht erst anfängt, wird nach
    // `MIC_MAX_WAIT_MS` als "nichts gehört" gemeldet.
    hardTimeout = setTimeout(() => evaluate(), MIC_MAX_WAIT_MS);

    // Speaking-Events sind die verlässlichste Trennung zwischen Sprache und
    // Rauschen – der Pegel allein reicht bei laufendem Hintergrund nicht.
    const speaking = connection.receiver.speaking;
    const onSpeakStart = (userId: string): void => {
      if (userId !== memberId || settled) return;
      isSpeaking = true;
      sawSpeakingEvent = true;
      // Das Zeitfenster wird hier bewusst noch nicht verkürzt: Discord meldet
      // auch kurze Störgeräusche als "spricht". Erst ein wirklich verwertbarer
      // Ton (`noteFirstTone`) zählt als Anfang.
    };
    const onSpeakEnd = (userId: string): void => {
      if (userId !== memberId) return;
      isSpeaking = false;
      // Kurze Stille abwarten – eine Pause mitten im Satz ist kein Fehlschlag,
      // `onSilenceExpired` entscheidet dann, ob weiter zugehört wird.
      armEvaluation(MIC_EVAL_SILENCE_MS);
    };
    speaking.on("start", onSpeakStart);
    speaking.on("end", onSpeakEnd);
    detachers.push(() => {
      speaking.off("start", onSpeakStart);
      speaking.off("end", onSpeakEnd);
    });

    // Bricht das Mitglied vorher ab, endet der Check sofort – sonst würde die
    // ganze Schlange bis zum Ende des Zeitfensters blockiert bleiben.
    detachers.push(
      onAbort(signal, () => {
        finish({ ok: false, reason: "aborted", speechMs: 0, level: 0, peak: 0, snr: 0 });
      }),
    );
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
 * Gesamtzahl der Wartenden über alle Server – für die Statuszeile des Bots.
 */
export function totalWaitingCount(): number {
  let sum = 0;
  for (const list of waitingOrder.values()) sum += list.length;
  return sum;
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

/**
 * Steht das Mitglied noch in der Warteschlange? Zwischen dem Einreihen und
 * dem tatsächlichen Start liegen Sekunden (vorheriger Durchlauf, Schlange).
 * Wer in dieser Zeit geht, darf nicht mehr angesprochen werden.
 */
export function isWaiting(guildId: string, userId: string): boolean {
  return waitingOrder.get(guildId)?.includes(userId) ?? false;
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
 * Erster Wartender, für den `isEligible` true ist – ohne ihn zu entfernen.
 * Damit lässt sich ein Mitglied in Abklingzeit überspringen, ohne die
 * FIFO-Reihenfolge der übrigen zu ändern.
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
 * "guildId:userId" → Zeitstempel, ab dem wieder geprüft werden darf.
 * Nach einem endgültig fehlgeschlagenen Check wartet das Mitglied, statt die
 * ganze Schlange mit einem kaputten Mikrofon aufzuhalten.
 */
const cooldowns = new Map<string, number>();

/** Setzt eine Wartezeit für ein Mitglied. */
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

/** Hebt eine Wartezeit auf, z. B. nach erfolgreicher Prüfung. */
export function clearCooldown(guildId: string, userId: string): void {
  cooldowns.delete(entryKey(guildId, userId));
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
