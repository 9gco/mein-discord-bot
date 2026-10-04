import { beforeAll, describe, expect, it } from "vitest";

process.env["DISCORD_TOKEN"] ??= "test-token";
process.env["DISCORD_CLIENT_ID"] ??= "test-client";

type VerifyModule = typeof import("./verify.js");

let verify: VerifyModule;

beforeAll(async () => {
  verify = await import("./verify.js");
});

const GUILD = "1000";

describe("Warteschlange", () => {
  it("vergibt fortlaufende Nummern in Beitrittsreihenfolge", () => {
    expect(verify.enqueueWaiting(GUILD, "a", null, "Alpha")).toBe(1);
    expect(verify.enqueueWaiting(GUILD, "b", null, "Bravo")).toBe(2);
    expect(verify.enqueueWaiting(GUILD, "c", null, "Charlie")).toBe(3);
  });

  it("gibt ein bereits wartendes Mitglied keine zweite Nummer", () => {
    verify.enqueueWaiting(GUILD, "a", null, "Alpha");
    expect(verify.enqueueWaiting(GUILD, "a", null, "Alpha")).toBe(1);
  });

  it("rückt nach dem Verlassen nach, ohne Lücken", () => {
    verify.enqueueWaiting(GUILD, "a", null, "Alpha");
    verify.enqueueWaiting(GUILD, "b", null, "Bravo");
    verify.enqueueWaiting(GUILD, "c", null, "Charlie");

    expect(verify.peekNextWaiting(GUILD)?.userId).toBe("a");

    expect(verify.dequeueWaiting(GUILD, "a")).toBe(true);
    expect(verify.peekNextWaiting(GUILD)?.userId).toBe("b");

    expect(verify.enqueueWaiting(GUILD, "d", null, "Delta")).toBe(3);
    // "c" stand schon in der Schlange und rückt jetzt auf Position 2.
    expect(verify.enqueueWaiting(GUILD, "c", null, "Charlie")).toBe(2);
  });

  it("meldet false, wenn jemand nicht in der Schlange stand", () => {
    expect(verify.dequeueWaiting(GUILD, "unbekannt")).toBe(false);
  });

  it("vergibt Nummern pro Server getrennt", () => {
    verify.enqueueWaiting("2000", "x", null, "Xray");
    expect(verify.enqueueWaiting("2000", "y", null, "Yankee")).toBe(2);
    // Eigener Server, eigene Zählung – unabhängig von den anderen Tests.
    expect(verify.enqueueWaiting("3000", "neu", null, "Neu")).toBe(1);
  });
});

describe("Namensnummern", () => {
  it("entfernt das '(n) '-Präfix, damit die Zahl nie vorgelesen wird", () => {
    expect(verify.spokenName("(3) Charlie")).toBe("Charlie");
    expect(verify.spokenName("(12) Delta")).toBe("Delta");
  });

  it("lässt Namen ohne Präfix unverändert", () => {
    expect(verify.spokenName("Echo")).toBe("Echo");
  });

  it("verkraftet auch einen Präfix mit Doppelleerzeichen", () => {
    expect(verify.spokenName("(1)  Foxtrot")).toBe("Foxtrot");
  });
});