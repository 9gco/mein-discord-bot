/**
 * Legt die hochzuladende `main.js` auf den Desktop.
 *
 * Warum es das gibt: Die Datei, die auf dem Server landet, ist nicht die aus dem
 * Git-Repository, sondern eine einzelne Datei, die man von Hand hochlädt. Das
 * führt zu zwei Ärgerissen:
 *
 * 1. Vergisst man das Kopieren, landet eine alte Datei auf dem Server. Der
 *    Zeitstempel sagt nichts: Copy-Dateien behalten ihn vom Original, die
 *    hochgeladene Datei sieht damit aus, als wäre sie vom Vortag - auch wenn
 *    sie gerade eben kopiert wurde.
 * 2. Ein Unix-Zeilenumbruch, der beim Kopieren aus Windows heraus entsteht,
 *    bricht den Startbefehl des Panels zusammen. Das ist der teuerste Fehler
 *    von beiden, weil der Container danach tot bleibt.
 *
 * Deshalb hängt das hier am Build: sobald `npm run build` läuft, liegt die
 * Datei bereit. Das Skript beachtet drei Regeln:
 *
 * - Zeilenenden werden auf LF normalisiert und ein Byte Order Mark entfernt.
 * - Die Datei bekommt die aktuelle Uhrzeit, damit „gerade eben kopiert" auch
 *   wirklich so aussieht.
 * - Fehlt der Desktop (Linux, Container, CI), bricht nichts ab.
 *
 * Aufruf: `npm run desktop`
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = join(ROOT, "main.js");

/**
 * Desktop-Ordner dieses Systems. Nur die Stellen, an denen Windows ihn ablegt;
 * alles andere wird still übersprungen, weil es im Betrieb nichts zu tun hat.
 */
function findDesktop() {
  const home = homedir();
  const candidates = [join(home, "Desktop"), join(home, "OneDrive", "Desktop")];

  return candidates.find((path) => existsSync(path) && statSync(path).isDirectory()) ?? null;
}

/** Liest die Kennung aus der Datei, damit die Ausgabe den Inhalt bestätigt. */
function readBootstrapVersion(text) {
  return text.match(/BOOTSTRAP_BUILD\s*=\s*"([^"]*)"/)?.[1] ?? "unbekannt";
}

function main() {
  const source = readFileSync(SOURCE);

  // CRLF und BOM entfernen: der Startbefehl des Panels läuft in einer Shell,
  // und ein \r darin macht aus jedem Befehl einen neuen.
  const text = source.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const normalized = Buffer.from(text, "utf8");

  const desktop = findDesktop();
  if (!desktop) {
    console.log("[desktop] Kein Desktop-Ordner gefunden, Datei nicht kopiert.");
    return;
  }

  const target = join(desktop, "main.js");
  writeFileSync(target, normalized);

  // Die Uhrzeit von jetzt: die Datei sieht damit aus, wie sie aussieht.
  const now = new Date();
  utimesSync(target, now, now);

  // Gegenlesen. Eine Kopie, die von der Quelle abweicht, ist schlimmer als
  // gar keine - dann weiß niemand mehr, welche der beiden Dateien stimmt.
  const written = readFileSync(target);
  const digest = createHash("sha256").update(written).digest("hex");
  const same = written.equals(normalized) && digest === createHash("sha256").update(source).digest("hex");

  if (!same) {
    throw new Error("Die kopierte Datei weicht von der Quelle ab.");
  }

  console.log(`[desktop] main.js -> ${target}`);
  console.log(`[desktop] ${written.length} Bytes, LF, ohne BOM, Stand ${now.toLocaleTimeString("de-DE")}`);
  console.log(`[desktop] Bootstrap ${readBootstrapVersion(text)}`);
}

main();