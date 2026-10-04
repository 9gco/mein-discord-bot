import { loadConfig } from "../config.js";
import { createJsonStore } from "./storage.js";
export const APPROVE_EMOJI = "👍";
export const keysStore = createJsonStore(loadConfig(), "analyse-keys.json", {
    keys: [],
});
export function renderKeyMessage(key) {
    return [
        "# 📊  A N A L Y S E - K E Y   Z U W E I S U N G",
        "",
        `🔑   DEIN KEY:   ${key}`,
        "",
        "# ⚠️   W I C H T I G E R   H I N W E I S :",
        "",
        `» Bitte reagiere SOFORT mit einem Emoji (${APPROVE_EMOJI}) auf diese Nachricht, sobald du den Key eingelöst hast!`,
        "",
        "» Mit dem Abhaken wird der Key als VERBRAUCHT markiert, um Doppelnutzungen durch andere Analysten zu verhindern.",
    ].join("\n");
}
export async function findEntryByMessageId(messageId) {
    const data = await keysStore.read();
    data.keys ??= [];
    return data.keys.find((k) => k.messageId === messageId);
}
export async function findEntryByKey(key) {
    const data = await keysStore.read();
    data.keys ??= [];
    return data.keys.find((k) => k.key === key);
}
export async function findEntriesByTarget(targetUserId) {
    const data = await keysStore.read();
    data.keys ??= [];
    return data.keys
        .filter((k) => k.targetUserId === targetUserId)
        .sort((a, b) => b.createdAt - a.createdAt);
}
export async function issueKey(entry) {
    return keysStore.update((data) => {
        data.keys ??= [];
        const created = {
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
export async function consumeKey(messageId, at) {
    return keysStore.update((data) => {
        data.keys ??= [];
        const target = data.keys.find((k) => k.messageId === messageId);
        if (!target || target.consumed || target.revoked)
            return undefined;
        target.consumed = true;
        target.consumedAt = at;
        return target;
    });
}
export async function revokeKey(key) {
    return keysStore.update((data) => {
        data.keys ??= [];
        const target = data.keys.find((k) => k.key === key);
        if (!target)
            return undefined;
        target.revoked = true;
        target.consumed = false;
        target.consumedAt = undefined;
        return target;
    });
}
