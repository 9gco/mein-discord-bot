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
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = dirname(fileURLToPath(import.meta.url));

/**
 * Stand dieses Bootstrap. Steht als erste Zeile im Log und beantwortet die
 * Frage "ist meine main.js aktuell?" ohne Dateivergleich - der Zeitstempel der
 * hochgeladenen Datei sagt nichts aus, Copy-Dateien behalten ihn vom Original.
 *
 * Bei jeder inhaltlichen Aenderung hier hochzaehlen.
 */
const BOOTSTRAP_BUILD = "2026-10-06a";
console.log(`[start] Bootstrap ${BOOTSTRAP_BUILD}`);

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
const DIST = join(APP, "dist");
const DIST_BACKUP = `${DIST}.previous`;
const STATE = process.env.PERSISTENT_DATA_DIR || join(HOME, "data");

const PENDING_FILE = join(STATE, ".pending-sha");
const ATTEMPT_FILE = join(STATE, ".pending-attempt");
const BOOTED_FILE = join(STATE, ".booted");
const SYNCED_FILE = join(STATE, ".synced-sha");

/** Wie lange der neue Build nach einem Update Zeit bekommt, sich anzumelden. */
const BOOT_GRACE_MS = 150_000;

/**
 * Freier Speicher auf der Platte, auf der der Bot liegt. Der Free-Tier-Host hat
 * rund 2 GB - `npm ci` in einem zweiten Verzeichnis hat da schon in
 * "no space left on device" gelaufen. Die Zahl steht jetzt im Log, damit das
 * nicht wieder überraschend auftritt.
 */
function logFreeSpace() {
  try {
    const { bavail, bsize } = statfsSync(APP);
    console.log(`[start] Freier Speicher: ${Math.round((bavail * bsize) / 1024 / 1024)} MB`);
  } catch {
    /* Nicht jeder Host erlaubt die Abfrage - dann eben keine Ausgabe. */
  }
}

function runSafe(cwd, command, args) {
  try {
    run(cwd, command, args);
  } catch {
    /* Bestmoeglich: der Cache ist nur eine Optimierung. */
  }
}

/**
 * Meldet dem Rollback-Wächter, dass dieser Start der erste Versuch war. Existiert
 * die Datei schon, war der vorige Start ohne Anmeldung zu Ende - dann muss
 * zurückgerollt werden, sonst startet der Bot endlos in denselben Fehler.
 */
function claimPendingAttempt() {
  if (existsSync(ATTEMPT_FILE)) return false;
  try {
    writeFileSync(ATTEMPT_FILE, `${Date.now()}\n`, "utf8");
    return true;
  } catch {
    return true;
  }
}

function readPending() {
  try {
    const [sha, prevSha] = readFileSync(PENDING_FILE, "utf8").trim().split(/\s+/);
    return sha && prevSha ? { sha, prevSha } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Nimmt das Update an: Der Bot hat sich angemeldet, also den neuen Stand
 * bestätigt. Marker und Backup koennen weg.
 */
function confirmPending() {
  rmSync(PENDING_FILE, { force: true });
  rmSync(ATTEMPT_FILE, { force: true });
  rmSync(DIST_BACKUP, { recursive: true, force: true });
}

/**
 * Setzt den Stand von vor dem Update wieder her: Quellen per `git reset` und der
 * gebaute Code aus `dist.previous`. Danach beendet sich der Prozess, damit der
 * Host mit dem alten Stand neu startet.
 */
function rollback(pending) {
  console.error(`[start] letzter Start blieb ohne Anmeldung - Rollback auf ${pending.prevSha.slice(0, 8)}`);
  if (existsSync(join(APP, ".git"))) {
    runSafe(APP, "git", ["reset", "--hard", pending.prevSha]);
  }
  if (existsSync(DIST_BACKUP)) {
    rmSync(DIST, { recursive: true, force: true });
    try {
      renameSync(DIST_BACKUP, DIST);
    } catch (err) {
      console.error("[start] Rollback fehlgeschlagen:", err.message);
    }
  }
  try {
    writeFileSync(SYNCED_FILE, `${pending.prevSha}\n`, "utf8");
    rmSync(PENDING_FILE, { force: true });
    rmSync(ATTEMPT_FILE, { force: true });
  } catch {
    /* Zustandsdateien sind nur Komfort. */
  }
  console.error("[start] Rollback fertig, der Host startet neu. Im Log sollte danach 'Bot ist online' stehen.");
  process.exit(1);
}

/**
 * Beobachtet, ob der neue Build sich anmeldet. Bleibt das aus, wird der alte
 * Stand wiederhergestellt - ein fehlerhafter Push darf den Bot nicht dauerhaft
 * ausser Betrieb nehmen.
 */
function watchForBootConfirmation(pending) {
  const deadline = Date.now() + BOOT_GRACE_MS;
  const poll = setInterval(() => {
    if (existsSync(BOOTED_FILE)) {
      clearInterval(poll);
      console.log("[start] Neustart erfolgreich, Update ist bestätigt");
      confirmPending();
      return;
    }
    if (Date.now() >= deadline) {
      clearInterval(poll);
      rollback(pending);
    }
  }, 5_000);
  poll.unref?.();
}

const pending = readPending();
if (pending) {
  if (existsSync(BOOTED_FILE)) {
    console.log("[start] vorheriges Update ist bestätigt, räume auf");
    confirmPending();
  } else if (claimPendingAttempt()) {
    console.log(`[start] Update ${pending.sha.slice(0, 8)} wird geprüft - Absturz innerhalb von ${BOOT_GRACE_MS / 1000}s wird zurückgerollt`);
    watchForBootConfirmation(pending);
  } else {
    // Zweiter Versuch ohne Anmeldung: der neue Build kommt nicht hoch.
    rollback(pending);
  }
}

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

/**
 * Müssen die Pakete neu installiert werden?
 *
 * `npm install` legt `node_modules` neu an; auf der kleinen Platte des Hosts
 * kostet das rund 165 MB und gut eine Minute. Wenn nur Quelltext geaendert
 * wurde, reicht `npm run build`. Als Massstab dient `node_modules/.package-lock.json`,
 * das npm bei jeder Installation selbst schreibt: ist die `package-lock.json`
 * im Repository aelter, passen die Pakete noch.
 */
function needsInstall(dir) {
  const lock = join(dir, "package-lock.json");
  const marker = join(dir, "node_modules", ".package-lock.json");
  if (!existsSync(join(dir, "node_modules", "discord.js"))) return true;
  if (!existsSync(lock) || !existsSync(marker)) return true;
  return statSync(lock).mtimeMs > statSync(marker).mtimeMs;
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
  if (needsInstall(APP)) {
    // Das Egg installiert vorher mit `npm install --production`, also ohne
    // Dev-Dependencies. TypeScript gehoert zu den Dev-Dependencies und waere
    // beim Build nicht vorhanden. Deshalb hier ausdruecklich mit.
    run(APP, "npm", ["install", "--include=dev", "--no-audit", "--no-fund"]);
    // Der Cache waechst sonst ueber die Updates auf mehrere hundert MB an und
    // war die haeufigste Ursache fuer "no space left on device".
    runSafe(APP, "npm", ["cache", "clean", "--force"]);
  } else {
    console.log("[start] node_modules passt zur package-lock.json, npm install entfällt");
  }
  run(APP, "npm", ["run", "build"]);
} else {
  console.log("[start] dist/ ist aktuell, starte ohne Build");
}

logFreeSpace();

await import(pathToFileURL(ENTRY).href);