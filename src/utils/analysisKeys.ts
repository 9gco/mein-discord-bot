import { loadConfig } from "../config.js";
import { createJsonStore } from "./storage.js";
import { logger } from "./logger.js";

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

export interface GeneratedKey {
  key: string;
  plan: string;
  createdAt: string;
  expiresAt: string | null;
}

/**
 * Generiert einen neuen Lizenz-Key über den SBAN-Server Admin-API.
 * Benötigt GAMMA_API_KEY als X-Admin-Token.
 */
export async function generateKey(
  days: number,
  plan: string,
  note: string,
): Promise<GeneratedKey | undefined> {
  const config = loadConfig();

  if (!config.license.adminToken) {
    logger.error("GAMMA_API_KEY ist nicht gesetzt – Key-Generierung nicht möglich.");
    return undefined;
  }

  try {
    const res = await fetch(`${config.license.serverUrl}/api/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": config.license.adminToken,
      },
      body: JSON.stringify({
        days: days <= 0 ? 30 : days,
        plan: plan || "standard",
        note,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error("Key-Generierung API-Fehler.", {
        status: res.status,
        body: body.slice(0, 200),
      });
      return undefined;
    }

    const data = await res.json();
    return {
      key: data.key,
      plan: data.plan ?? plan,
      createdAt: data.createdAt ?? new Date().toISOString(),
      expiresAt: data.expiresAt ?? null,
    };
  } catch (err) {
    logger.error("Fehler bei der Key-Generierung.", { error: err });
    return undefined;
  }
}

export interface KeyValidation {
  valid: boolean;
  plan?: string;
  expiresAt?: string;
  reason?: string;
  uses?: number;
}

/**
 * Validiert einen Key über die öffentliche /api/auth/validate Endpoint.
 * Benötigt keinen Admin-Token.
 */
export async function validateKey(key: string): Promise<KeyValidation | undefined> {
  const config = loadConfig();
  try {
    const res = await fetch(`${config.license.serverUrl}/api/auth/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      return { valid: false, reason: `http_${res.status}` };
    }
    return (await res.json()) as KeyValidation;
  } catch (err) {
    logger.error("Fehler bei der Key-Validierung.", { error: err, key });
    return undefined;
  }
}

export interface KeyDetails {
  key: string;
  plan: string;
  createdAt: string;
  expiresAt: string | null;
  revoked: boolean;
  uses: number;
  lastUsedAt: string | null;
  note: string | null;
}

/**
 * Liefert Details zu einem einzelnen Key über die Admin-API.
 * Benötigt GAMMA_API_KEY als X-Admin-Token.
 */
export async function findKeyDetails(key: string): Promise<KeyDetails | undefined> {
  const config = loadConfig();
  if (!config.license.adminToken) return undefined;
  try {
    const res = await fetch(`${config.license.serverUrl}/api/admin/keys`, {
      headers: { "X-Admin-Token": config.license.adminToken },
    });
    if (!res.ok) return undefined;
    const keys = (await res.json()) as Array<{
      Key: string; Plan: string; CreatedAt: string; ExpiresAt: string | null;
      Revoked: boolean; Uses: number; LastUsedAt: string | null; Note: string | null;
    }>;
    const entry = keys.find((k) => k.Key.toLowerCase() === key.toLowerCase());
    if (!entry) return undefined;
    return {
      key: entry.Key,
      plan: entry.Plan,
      createdAt: entry.CreatedAt,
      expiresAt: entry.ExpiresAt,
      revoked: entry.Revoked,
      uses: entry.Uses,
      lastUsedAt: entry.LastUsedAt,
      note: entry.Note,
    };
  } catch (err) {
    logger.error("Fehler beim Abruf der Key-Details.", { error: err, key });
    return undefined;
  }
}
