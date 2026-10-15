import { describe, expect, it } from "vitest";
import { freeSpaceMb, isNoSpaceError } from "./diskSpace.js";

describe("isNoSpaceError", () => {
  it("erkennt ENOSPC in der Fehlermeldung", () => {
    expect(isNoSpaceError(new Error("ENOSPC: no space left on device, write"))).toBe(true);
  });

  it("erkennt den npm-Fehler im stderr", () => {
    // execFile haengt stderr an das Error-objekt; die Meldung selbst kann
    // ohne den Text bleiben ("Command failed: npm ci").
    const err = Object.assign(new Error("Command failed: npm ci"), {
      stderr: "npm error code ENOSPC\nnpm error syscall write\n",
    });
    expect(isNoSpaceError(err)).toBe(true);
  });

  it("erkennt Buffer-stderr", () => {
    const err = Object.assign(new Error("Command failed"), {
      stderr: Buffer.from("npm error nospc ENOSPC: no space left on device"),
    });
    expect(isNoSpaceError(err)).toBe(true);
  });

  it("laesst andere Fehler unangetastet", () => {
    expect(isNoSpaceError(new Error("Command failed: npm ci"))).toBe(false);
    expect(isNoSpaceError(new TypeError("undefined"))).toBe(false);
    expect(isNoSpaceError("plain string")).toBe(false);
  });
});

describe("freeSpaceMb", () => {
  it("liefert den freien Platz des Arbeitsverzeichnisses", () => {
    const free = freeSpaceMb(process.cwd());
    expect(free).toBeTypeOf("number");
    expect(free).toBeGreaterThan(0);
  });

  it("liefert undefined, wenn der Pfad nicht abfragbar ist", () => {
    expect(freeSpaceMb("/mdb-test-pfad-existiert-nicht-42")).toBeUndefined();
  });
});
