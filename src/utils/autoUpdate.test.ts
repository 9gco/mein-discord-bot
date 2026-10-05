import { describe, expect, it } from "vitest";
import { needsUpdate, parseRemoteSha, readAutoUpdateSettings } from "./autoUpdate.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("parseRemoteSha", () => {
  it("liest die Revision des gewaehlten Branches", () => {
    const stdout = `${SHA_A}\trefs/heads/main\n`;
    expect(parseRemoteSha(stdout, "main")).toBe(SHA_A);
  });

  it("ignoriert Tags und HEAD", () => {
    const stdout = [
      `${SHA_A}\trefs/tags/v1.0.0`,
      `${SHA_B}\tHEAD`,
      "notasha\trefs/heads/main",
      `${SHA_A.replace(/a/g, "c")}\trefs/heads/dev`,
    ].join("\n");
    expect(parseRemoteSha(stdout, "main")).toBeUndefined();
  });

  it("nimmt bei mehreren Branches den richtigen", () => {
    const stdout = [
      `${SHA_A}\trefs/heads/dev`,
      `${SHA_B}\trefs/heads/main`,
      "notasha\trefs/heads/feature",
    ].join("\n");
    expect(parseRemoteSha(stdout, "main")).toBe(SHA_B);
  });

  it("kommt ohne Treffer mit undefined zurueck", () => {
    expect(parseRemoteSha("", "main")).toBeUndefined();
    expect(parseRemoteSha(`${SHA_A}\trefs/heads/main`, "other")).toBeUndefined();
  });

  it("verwirft zu kurze oder zu lange Kandidaten", () => {
    expect(parseRemoteSha("abc123\trefs/heads/main", "main")).toBeUndefined();
    expect(parseRemoteSha(`${"a".repeat(41)}\trefs/heads/main`, "main")).toBeUndefined();
  });
});

describe("needsUpdate", () => {
  it("aktualisiert, wenn die Revision abweicht", () => {
    expect(needsUpdate(SHA_A, SHA_B)).toBe(true);
  });

  it("laeuft bei gleicher Revision nicht", () => {
    expect(needsUpdate(SHA_A, SHA_A)).toBe(false);
  });

  it("aktualisiert beim ersten Start nicht", () => {
    // Ohne bekannte Revision nehmen wir an, dass der hochgeladene Stand zu
    // main passt. Sonst wuerde jeder erste Start sofort ein Update ausloesen.
    expect(needsUpdate(undefined, SHA_A)).toBe(false);
  });
});

describe("readAutoUpdateSettings", () => {
  it("ist ohne AUTO_UPDATE inaktiv", () => {
    expect(readAutoUpdateSettings({})).toBeUndefined();
    expect(readAutoUpdateSettings({ AUTO_UPDATE: "false" })).toBeUndefined();
    expect(readAutoUpdateSettings({ AUTO_UPDATE: "0" })).toBeUndefined();
    expect(readAutoUpdateSettings({ AUTO_UPDATE: "" })).toBeUndefined();
  });

  it("akzeptiert true und die Schreibweise der Pterodactyl-Eggs", () => {
    // Das Egg zieht sein eigenes git pull bei AUTO_UPDATE=1 und erwartet
    // dann, dass auch der Bot sich aktualisiert.
    for (const value of ["true", "1", "TRUE", "yes"]) {
      expect(readAutoUpdateSettings({ AUTO_UPDATE: value })).toBeDefined();
    }
  });

  it("nutzt Vorgaben, wenn nichts weiter gesetzt ist", () => {
    const settings = readAutoUpdateSettings({ AUTO_UPDATE: "true" }, "/srv/bot");
    expect(settings).toBeDefined();
    expect(settings?.branch).toBe("main");
    expect(settings?.appDir).toBe("/srv/bot");
    expect(settings?.intervalMin).toBe(10);
  });

  it("legt den Revisionsstand in den persistenten Daten ab", () => {
    const settings = readAutoUpdateSettings(
      { AUTO_UPDATE: "true", PERSISTENT_DATA_DIR: "/var/lib/bot" },
      "/srv/bot",
    );
    // Sonst waechst die Datei bei jedem Redeploy im weggeworfenen Image.
    expect(settings?.stateDir).toBe("/var/lib/bot");
  });

  it("verwirft unsinnige Intervalle", () => {
    const settings = readAutoUpdateSettings({
      AUTO_UPDATE: "true",
      AUTO_UPDATE_INTERVAL_MIN: "0",
    });
    expect(settings?.intervalMin).toBe(10);
  });

  it("erlaubt ein kuerzeres Intervall", () => {
    const settings = readAutoUpdateSettings({
      AUTO_UPDATE: "true",
      AUTO_UPDATE_INTERVAL_MIN: "2",
    });
    expect(settings?.intervalMin).toBe(2);
  });
});