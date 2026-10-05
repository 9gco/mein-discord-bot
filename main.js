/**
 * Einstiegspunkt fuer Hosts, die nur einen festen Startbefehl anbieten.
 *
 * Das Pterodactyl-NodeJS-Egg auf Monkey Network laesst den Startbefehl nicht
 * aendern. Es macht immer: `git pull`, `npm install --production`, dann
 * `node <Hauptdatei>`. Deshalb ist `main.js` die Hauptdatei statt
 * `dist/index.js`, und es bringt seinen Code selbst mit, falls das Egg nichts
 * geklont hat.
 *
 * Reihenfolge:
 *   1. Code holen   - entweder hat das Egg schon geklont, sonst wird hier
 *                     nach /home/container/app geklont
 *   2. Bauen        - dist/ ist gitignored und fehlt nach jedem git pull
 *   3. Starten      - dist/index.js wird importiert
 *
 * Ohne Token laeuft der Bot bis zur Konfigurationspruefung und bricht dann mit
 * einer klaren Meldung ab.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = dirname(fileURLToPath(import.meta.url));

/**
 * Liest eine .env-Datei ohne Dependency. main.js laeuft vor `npm install`,
 * dotenv waere da also noch nicht verfuegbar - deshalb wird hier von Hand
 * geparst. `bot.env` wird mitgelesen, weil manche Dateimanager Dateien mit
 * Punkt am Anfang ausblenden.
 *
 * Vorhandene Environment-Variablen des Panels haben Vorrang, damit dort
 * gesetzte Werte nicht von der Datei ueberschrieben werden.
 */
function loadEnvFile(dir) {
  for (const name of [".env", "bot.env"]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;

    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    console.log(`[start] Lese ${name}`);
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, "");
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // Nur den Namen protokollieren, niemals den Wert.
      if (key && value && process.env[key] === undefined) {
        process.env[key] = value;
        console.log(`[start]   gesetzt: ${key}`);
      }
    }
    return;
  }
}

loadEnvFile(HOME);

const REPO = process.env.GIT_REPO_URL || "https://github.com/9gco/mein-discord-bot.git";
const BRANCH = process.env.GIT_INSTALL_BRANCH || "main";

function run(cwd, command, args) {
  console.log(`[start] ${command} ${args.join(" ")}`);
  // Unter Windows heisst npm "npm.cmd", was execFile ohne Shell nicht findet.
  // Im Container ist npm ein normales Programm, die Shell schadet dort nicht.
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

/**
 * Liefert das Verzeichnis, in dem das Projekt liegt, und holt es bei Bedarf.
 * Legt das Egg nichts an, wird nach app/ geklont - `git clone` in ein
 * vorhandenes, nicht leeres Verzeichnis schlaegt sonst fehl, und app/ ist
 * durch main.js bereits belegt.
 */
function resolveAppDir() {
  if (existsSync(join(HOME, "package.json"))) {
    console.log("[start] Repository liegt direkt im Container, nutze es");
    return { dir: HOME, own: true };
  }

  const app = join(HOME, "app");
  if (!existsSync(join(app, "package.json"))) {
    console.log(`[start] kein Code im Container, klone ${REPO}`);
    execFileSync("git", ["clone", "--depth", "1", "--single-branch", "--branch", BRANCH, REPO, app], {
      cwd: HOME,
      stdio: "inherit",
    });
  } else {
    run(app, "git", ["pull", "--ff-only"]);
  }

  console.log("[start] Projektverzeichnis:", app);
  return { dir: app, own: false };
}

const { dir: APP } = resolveAppDir();
const ENTRY = join(APP, "dist", "index.js");

/**
 * Zeitstempel der juengsten Quelldatei. `git pull` setzt die Aenderungszeit
 * nur auf den Dateien um, die sich tatsaechlich geaendert haben - deshalb
 * reicht der Vergleich gegen ein einzelnes File nicht.
 */
function newestSourceMtime(dir) {
  let newest = 0;
  try {
    const walk = (path) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const full = join(path, entry.name);
        if (entry.isDirectory()) walk(full);
        else newest = Math.max(newest, statSync(full).mtimeMs);
      }
    };
    walk(join(dir, "src"));
  } catch {
    // Ohne src/ gibt es nichts zu vergleichen.
  }
  for (const name of ["package.json", "package-lock.json", "tsconfig.json"]) {
    try {
      newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
    } catch {
      /* Datei fehlt - dann nicht relevant. */
    }
  }
  return newest;
}

let needsBuild = !existsSync(ENTRY);
let reason = "dist/index.js fehlt";

if (!needsBuild) {
  const source = newestSourceMtime(APP);
  const built = statSync(ENTRY).mtimeMs;
  if (source > built) {
    needsBuild = true;
    reason = "Quellen sind neuer als dist/";
  }
}

if (needsBuild) {
  console.log(`[start] ${reason}, baue jetzt`);
  // Das Egg installiert vorher mit `npm install --production`, also ohne
  // Dev-Dependencies. TypeScript gehoert zu den Dev-Dependencies und waere
  // beim Build nicht vorhanden. Deshalb hier ausdruecklich mit.
  run(APP, "npm", ["install", "--include=dev", "--no-audit", "--no-fund"]);
  run(APP, "npm", ["run", "build"]);
} else {
  console.log("[start] dist/ ist aktuell, starte ohne Build");
}

await import(pathToFileURL(ENTRY).href);