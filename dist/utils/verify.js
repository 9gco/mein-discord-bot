import { Readable } from "node:stream";
import { AudioPlayerStatus, StreamType, VoiceConnectionStatus, createAudioPlayer, createAudioResource, entersState, getVoiceConnection, joinVoiceChannel, } from "@discordjs/voice";
import ffmpeg from "ffmpeg-static";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { loadConfig } from "../config.js";
import { createStorage } from "./storage.js";
import { logger } from "./logger.js";
if (ffmpeg)
    process.env.FFMPEG_PATH = ffmpeg;
const DEFAULT_CONFIG = {
    enabled: false,
    channelId: undefined,
    message: "Willkommen {user}. Du wirst gleich verifiziert. Bitte warte kurz.",
    voice: "de-DE-KatjaNeural",
    roles: [],
};
export const verifyStore = createStorage(loadConfig(), "verify");
export const VERIFY_VOICES = [
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
];
const LEGACY_LANG_TO_VOICE = {
    de: "de-DE-KatjaNeural",
    en: "en-US-AvaNeural",
    fr: "fr-FR-DeniseNeural",
    es: "es-ES-AlvaroNeural",
    tr: "tr-TR-EmelNeural",
};
const configCache = new Map();
function normalizeConfig(stored) {
    const legacy = stored;
    const storedVoice = typeof legacy?.voice === "string" && legacy.voice.includes("-")
        ? legacy.voice
        : legacy?.lang
            ? LEGACY_LANG_TO_VOICE[legacy.lang]
            : undefined;
    return {
        enabled: stored?.enabled ?? DEFAULT_CONFIG.enabled,
        channelId: stored?.channelId || undefined,
        message: typeof stored?.message === "string" && stored.message
            ? stored.message
            : DEFAULT_CONFIG.message,
        voice: storedVoice || DEFAULT_CONFIG.voice,
        roles: Array.isArray(stored?.roles) ? stored.roles : [],
    };
}
export async function getVerifyConfig(guildId) {
    const cached = configCache.get(guildId);
    if (cached)
        return cached;
    const cfg = normalizeConfig(await verifyStore.read(guildId));
    configCache.set(guildId, cfg);
    return cfg;
}
export function getCachedVerifyConfig(guildId) {
    const cached = configCache.get(guildId);
    if (!cached)
        return { ...DEFAULT_CONFIG, roles: [] };
    return { ...cached, roles: [...cached.roles] };
}
export async function saveVerifyConfig(guildId, cfg) {
    configCache.set(guildId, cfg);
    await verifyStore.write(guildId, cfg);
}
const TTS_CACHE_LIMIT = 40;
const ttsCache = new Map();
export async function fetchTtsAudio(text, voice) {
    const cacheKey = `${voice}::${text}`;
    const cached = ttsCache.get(cacheKey);
    if (cached)
        return cached;
    const buffer = await synthesizeSpeech(text, voice);
    ttsCache.set(cacheKey, buffer);
    while (ttsCache.size > TTS_CACHE_LIMIT) {
        const oldest = ttsCache.keys().next().value;
        if (oldest === undefined)
            break;
        ttsCache.delete(oldest);
    }
    return buffer;
}
async function synthesizeSpeech(text, voice) {
    const tts = new MsEdgeTTS();
    try {
        await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(text);
        const chunks = [];
        await new Promise((resolve, reject) => {
            audioStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            audioStream.once("end", () => resolve());
            audioStream.once("error", (err) => reject(err));
        });
        const buffer = Buffer.concat(chunks);
        if (buffer.length === 0)
            throw new Error("TTS returned an empty file.");
        return buffer;
    }
    finally {
        tts.close();
    }
}
export async function connectToVerifyChannel(guild, channelId) {
    const existing = getVoiceConnection(guild.id);
    if (existing && existing.joinConfig.channelId === channelId) {
        if (existing.state.status === VoiceConnectionStatus.Ready)
            return existing;
    }
    const connection = existing && existing.joinConfig.channelId === channelId
        ? existing
        : joinVoiceChannel({
            guildId: guild.id,
            channelId,
            adapterCreator: guild.voiceAdapterCreator,
            selfMute: true,
            selfDeaf: false,
        });
    try {
        await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    }
    catch {
        connection.destroy();
        return undefined;
    }
    return connection;
}
export function playBuffer(connection, buffer) {
    return new Promise((resolve) => {
        let settled = false;
        let timer;
        const player = createAudioPlayer();
        const resource = createAudioResource(Readable.from(buffer), {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
        });
        const finish = (timedOut) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            if (timedOut) {
                try {
                    player.stop();
                }
                catch {
                }
            }
            resolve();
        };
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
const guildQueues = new Map();
export function runExclusive(guildId, task) {
    const previous = guildQueues.get(guildId) ?? Promise.resolve();
    const next = previous
        .then(() => task())
        .catch((err) => {
        logger.error("Verify-Aufgabe fehlgeschlagen.", { guildId, error: err });
    });
    guildQueues.set(guildId, next);
    void next.finally(() => {
        if (guildQueues.get(guildId) === next)
            guildQueues.delete(guildId);
    });
    return next;
}
