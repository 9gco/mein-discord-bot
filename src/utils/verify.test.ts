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

describe("Wartezeit nach Fehlschlag", () => {
  const COOLDOWN = 60_000;

  it("gibt ohne Wartezeit sofort frei", () => {
    expect(verify.cooldownRemaining("4000", "a")).toBe(0);
  });

  it("setzt eine Wartezeit und zählt sie herunter", () => {
    verify.setCooldown("4000", "neu", COOLDOWN);
    const rest = verify.cooldownRemaining("4000", "neu");
    expect(rest).toBeGreaterThan(COOLDOWN - 5_000);
    expect(rest).toBeLessThanOrEqual(COOLDOWN);
  });

  it("gilt nur für dasselbe Mitglied", () => {
    verify.setCooldown("4000", "a", COOLDOWN);
    expect(verify.cooldownRemaining("4000", "b")).toBe(0);
  });

  it("lässt sich nach erfolgreicher Prüfung aufheben", () => {
    verify.setCooldown("4000", "c", COOLDOWN);
    verify.clearCooldown("4000", "c");
    expect(verify.cooldownRemaining("4000", "c")).toBe(0);
  });

  it("überspringt Wartende in Wartezeit, ohne die Reihenfolge zu ändern", () => {
    verify.enqueueWaiting("5000", "wartet", null, "Wartet");
    verify.enqueueWaiting("5000", "wartet2", null, "Wartet2");
    verify.enqueueWaiting("5000", "drangeht", null, "Drangeht");

    verify.setCooldown("5000", "wartet", COOLDOWN);

    // Wartender in Wartezeit wird übersprungen, der nächste ist dran.
    expect(verify.peekFirstEligible("5000", (id) => verify.cooldownRemaining("5000", id) === 0)?.userId).toBe(
      "wartet2",
    );
    // Der übersprungene bleibt trotzdem in der Schlange.
    expect(verify.peekNextWaiting("5000")?.userId).toBe("wartet");
  });

  it("liefert undefined, wenn alle in Wartezeit sind", () => {
    verify.enqueueWaiting("6000", "a", null, "Alpha");
    verify.setCooldown("6000", "a", COOLDOWN);
    expect(
      verify.peekFirstEligible("6000", (id) => verify.cooldownRemaining("6000", id) === 0),
    ).toBeUndefined();
  });
});

describe("Startberechtigung", () => {
  // Der Bot darf erst reden, wenn das Mitglied wirklich wartet und wirklich im
  // Prüf-Kanal steht. Beides wird vor dem Start und vor jeder Ansage geprüft.

  it("erkennt, wer noch in der Schlange steht", () => {
    verify.enqueueWaiting("7000", "a", null, "Alpha");
    verify.enqueueWaiting("7000", "b", null, "Bravo");
    expect(verify.isWaiting("7000", "a")).toBe(true);
    expect(verify.isWaiting("7000", "nicht-da")).toBe(false);
    expect(verify.isWaiting("8000", "a")).toBe(false);

    // Wer den Warteraum verlassen hat, ist nicht mehr am Start – sonst würde
    // der Bot noch in den Prüf-Kanal ziehen und dort ansprechen.
    verify.dequeueWaiting("7000", "a");
    expect(verify.isWaiting("7000", "a")).toBe(false);
  });

  const guildStub = (voiceStates: Record<string, { channelId: string | null; sessionId: string }>) =>
    ({
      voiceStates: { cache: new Map(Object.entries(voiceStates)) },
      members: { cache: new Map() },
    }) as never;

  it("erkennt ein Mitglied, das im Prüf-Kanal steht", () => {
    const guild = guildStub({ a: { channelId: "verify", sessionId: "s1" } });
    expect(verify.isMemberInChannel(guild, "a", "verify")).toBe(true);
    expect(verify.isMemberInChannel(guild, "a", "waiting")).toBe(false);
  });

  it("erkennt ein Mitglied, das den Kanal verlassen hat", () => {
    const guild = guildStub({ a: { channelId: null, sessionId: "" } });
    expect(verify.isMemberInChannel(guild, "a", "verify")).toBe(false);
  });

  it("behandelt ein unbekanntes Mitglied als 'nicht da'", () => {
    const guild = guildStub({});
    expect(verify.isMemberInChannel(guild, "weg", "verify")).toBe(false);
  });
});

describe("Namensnummern", () => {  it("entfernt das '(n) '-Präfix, damit die Zahl nie vorgelesen wird", () => {
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

describe("Mikrofon-Bewertung", () => {
  const good = {
    speechMs: 3000,
    level: 0.08,
    peak: 0.6,
    snr: 20,
    noiseKnown: true,
    hasLevels: true,
  };

  it("lässt ein gesundes Mikrofon durch", () => {
    expect(verify.judgeMicMeasurement(good)).toBe("ok");
  });

  it("meldet Stummgabe", () => {
    expect(verify.judgeMicMeasurement({ ...good, speechMs: 0 })).toBe(
      "no_speech",
    );
  });

  it("meldet zu kurzes Sprechen", () => {
    expect(verify.judgeMicMeasurement({ ...good, speechMs: 400 })).toBe(
      "too_short",
    );
  });

  it("meldet zu leises Sprechen", () => {
    expect(verify.judgeMicMeasurement({ ...good, level: 0.02 })).toBe(
      "too_quiet",
    );
  });

  it("meldet übersteuerte Mikrofone", () => {
    expect(verify.judgeMicMeasurement({ ...good, peak: 0.99 })).toBe(
      "clipping",
    );
  });

  it("meldet verrauschte Mikrofone", () => {
    expect(verify.judgeMicMeasurement({ ...good, snr: 2 })).toBe("noisy");
  });

  it("übersieht verrauschte Stimmen ohne Rauschschätzung", () => {
    // Ohne genug Stille-Frames lässt sich der Rauschboden nicht schätzen.
    expect(verify.judgeMicMeasurement({ ...good, snr: 0, noiseKnown: false })).toBe(
      "ok",
    );
  });

  it("bewertet ohne Pegelmessung nur die Sprechdauer", () => {
    expect(
      verify.judgeMicMeasurement({ ...good, hasLevels: false, peak: 0, level: 0 }),
    ).toBe("ok");
    expect(
      verify.judgeMicMeasurement({
        ...good,
        hasLevels: false,
        peak: 0,
        level: 0,
        speechMs: 200,
      }),
    ).toBe("too_short");
  });

  it("meldet Stummgabe vor Übersteuerung", () => {
    // Sonst würde ein stummes Mikrofon als 'clipping' durchfallen.
    expect(verify.judgeMicMeasurement({ ...good, speechMs: 0, peak: 1 })).toBe(
      "no_speech",
    );
  });
});

describe("Encoding-Reparatur", () => {
  // Bewusst so gebaut, wie Text nach doppeltem Kodieren aussieht: die
  // Umlaut-Buchstaben stehen als zwei Zeichen da.
  const kaputt = "Deutsch – Katja, Schön, Prüfe, anschließend";

  it("repariert doppelt kodierten Text", () => {
    expect(verify.repairMojibake(kaputt)).toBe(
      "Deutsch – Katja, Schön, Prüfe, anschließend",
    );
  });

  it("lässt korrekten Text unverändert", () => {
    const ok = "Deutsch – Katja, schön, öffne";
    expect(verify.repairMojibake(ok)).toBe(ok);
  });

  it("lässt reinen ASCII-Text unverändert", () => {
    expect(verify.repairMojibake("nur ascii")).toBe("nur ascii");
  });
});

describe("Satzweise Ansage", () => {
  it("zerlegt eine Ansage an den Satzzeichen", () => {
    expect(verify.splitSentences("Eins. Zwei! Drei?")).toEqual([
      "Eins.",
      "Zwei!",
      "Drei?",
    ]);
  });

  it("behält einen Satz ohne Satzzeichen als Ganzes", () => {
    expect(verify.splitSentences("nur ein Satz")).toEqual(["nur ein Satz"]);
  });

  it("trennt nicht an Dezimalzahlen", () => {
    // "0,8 Sekunden" darf nicht an der Zahl zerschnitten werden.
    expect(verify.splitSentences("Ich habe nur 0,8 Sekunden gehört.")).toEqual([
      "Ich habe nur 0,8 Sekunden gehört.",
    ]);
  });

  it("ignoriert überflüssige Leerzeichen", () => {
    expect(verify.splitSentences("Eins.   Zwei.")).toEqual(["Eins.", "Zwei."]);
  });

  it("gibt bei leerem Text nichts kaputtes zurück", () => {
    expect(verify.splitSentences("")).toEqual([""]);
  });
});

describe("Ansage in Stücken", () => {
  // Zu kurze Stücke klingen abgehackt, zu lange holen nicht mehr Luft. Der
  // wichtigste Fall: kurze Ansagen müssen in EINEM Stück bleiben.
  it("lässt eine kurze Ansage in einem Stück", () => {
    expect(verify.chunkAnnouncement("Hey Max, willkommen bei uns!")).toEqual([
      "Hey Max, willkommen bei uns!",
    ]);
  });

  it("führt zwei kurze Sätze zusammen", () => {
    expect(
      verify.chunkAnnouncement("Hey Max, willkommen bei uns! Schön, dass du da bist."),
    ).toEqual(["Hey Max, willkommen bei uns! Schön, dass du da bist."]);
  });

  it("trennt spätestens nach drei Sätzen", () => {
    const text = "Eins. Zwei. Drei. Vier.";
    expect(verify.chunkAnnouncement(text)).toEqual(["Eins. Zwei. Drei.", "Vier."]);
  });

  it("trennt an der Satzgrenze, wenn ein Stück zu lang würde", () => {
    const lang = `${"A".repeat(150)}. ${"B".repeat(150)}.`;
    const chunks = verify.chunkAnnouncement(lang);
    expect(chunks).toHaveLength(2);
    expect(chunks.join(" ")).toBe(lang);
  });

  it("trennt nie mitten im Satz", () => {
    // Ein einzelner langer Satz bleibt ein Stück: mitten im Satz zu schneiden
    // würde die Betonung zerhacken.
    const satz = `${"A".repeat(400)}.`;
    expect(verify.chunkAnnouncement(satz)).toEqual([satz]);
  });

  it("verliert beim Zusammenfassen keinen Text", () => {
    const text =
      "Hey Max, willkommen bei uns! Schön, dass du da bist. " +
      "Ich lass dich gleich kurz was sagen. Damit wir uns unterhalten können.";
    expect(verify.chunkAnnouncement(text).join(" ")).toBe(text);
  });

  it("behält Text ohne Satzzeichen als ein Stück", () => {
    expect(verify.chunkAnnouncement("nur ein Satz")).toEqual(["nur ein Satz"]);
  });
});