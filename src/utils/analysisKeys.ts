import { loadConfig } from "../config.js";
import { createJsonStore } from "./storage.js";

/** Das Emoji, mit dem ein Analyst den Empfang/eine Einlösung bestätigt. */
export const APPROVE_EMOJI = "👍";

export interface AnalysisKey {
  /** ID der gesendeten DM-Nachricht (dient als eindeutiger Beleg). */
  messageId: string;
  /** ID des DM-Kanals, in dem die Nachricht liegt. */
  channelId: string;
  guildId?: string;
  /** Der Analyst, der den Key erhalten soll. */
  targetUserId: string;
  /** Wer den Key vergeben hat (Admin). */
  issuedById: string;
  key: string;
  consumed: boolean;
  revoked: boolean;
  createdAt: number;
  consumedAt?: number;
}

interface KeysDoc {
  keys: AnalysisKey[];
}

/**
 * Ein JSON-Dokument, das alle vergebenen Keys speichert. Liegt in
 * config.storage.dir und übersteht Redeploys, solange persistent storage aktiv ist.
 */
export const keysStore = createJsonStore<KeysDoc>(loadConfig(), "analyse-keys.json", {
  keys: [],
});

/** Baut die vorgegebene Assignments-Nachricht für einen Key. */
export function renderKeyMessage(key: string): string {
  return [
    "# 📊  A N A L Y S E - K E Y   Z U W E I S U N G",
    "",
    `🔑   DEIN KEY:   ${key}`,
    "",
    "# ⚠️   W I C H T I G E R   H I N W E I S :",
    "",
    `» Bitte reagiere SOFORT mit einem Emoji (${APPROVE_EMOJI}) auf diese Nachricht sobald du den Key eingelöst hast!`,
    "",
    "» Mit dem Abhaken wird der Key als VERBRAUCHT markiert um Doppelnutzungen durch andere Analysten zu verhindern.",
  ].join("\n");
}

export async function findEntryByMessageId(
  messageId: string,
): Promise<AnalysisKey | undefined> {
  const data = await keysStore.read();
  data.keys ??= [];
  return data.keys.find((k) => k.messageId === messageId);
}

export async function findEntryByKey(key: string): Promise<AnalysisKey | undefined> {
  const data = await keysStore.read();
  data.keys ??= [];
  return data.keys.find((k) => k.key === key);
}

export async function findEntriesByTarget(
  targetUserId: string,
): Promise<AnalysisKey[]> {
  const data = await keysStore.read();
  data.keys ??= [];
  return data.keys
    .filter((k) => k.targetUserId === targetUserId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function issueKey(
  entry: Omit<AnalysisKey, "consumed" | "revoked" | "createdAt" | "consumedAt">,
): Promise<AnalysisKey> {
  return keysStore.update((data) => {
    data.keys ??= [];
    const created: AnalysisKey = {
      ...entry,
      consumed: false,
      revoked: false,
      consumedAt: undefined,
      createdAt: Date.now(),
    };
    data.keys.push(created);
    return created;
  });
}

export async function consumeKey(
  messageId: string,
  at: number,
): Promise<AnalysisKey | undefined> {
  return keysStore.update((data) => {
    data.keys ??= [];
    const target = data.keys.find((k) => k.messageId === messageId);
    if (!target || target.consumed || target.revoked) return undefined;
    target.consumed = true;
    target.consumedAt = at;
    return target;
  });
}

export async function revokeKey(key: string): Promise<AnalysisKey | undefined> {
  return keysStore.update((data) => {
    data.keys ??= [];
    const target = data.keys.find((k) => k.key === key);
    if (!target) return undefined;
    target.revoked = true;
    target.consumed = false;
    target.consumedAt = undefined;
    return target;
  });
}
