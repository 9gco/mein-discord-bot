import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { logger } from "./logger.js";

/**
 * Selbst-Update: der Bot holt sich neue Versionen von einem öffentlichen Git-
 * Repository und startet sich neu. Damit funktioniert "push auf main, Bot
 * aktualisiert sich" auch auf Hostern ohne API-Schreibrechte und ohne Karte –
 * auf den Pterodactyl-Free-Tier-Instanzen wäre SFTP die einzige Alternative.
 *
 * Standardmaßig aus. Aktivieren mit `AUTO_UPDATE=true`.
 *
 * Der Ablauf ist bewusst so gebaut, dass ein fehlerhafter Push den laufenden
 * Bot nicht zerstört: `dist/` wird vor dem Build zur Seite gelegt, der alte
 * Stand kommt zurück, wenn der Build scheitert. Nach einem erfolgreichen Build
 * bleibt der alte Stand als `dist.previous` liegen, bis `main.js` den Start
 * bestätigt - danach ist das Update angenommen.
 *
 * Gebaut wird im Anwendungsverzeichnis selbst, nicht in einem zweiten Klon:
 * ein zweites `node_modules` kostet auf der 2-GB-Platte rund 165 MB extra und
 * lief dort in "no space left on device". Ohne `.git` wird weiterhin über ein
 * Staging-Verzeichnis gebaut, weil dann die Quellen fehlen.
 */

const execFileAsync = promisify(execFile);

const DEFAULT_REPO = "https://github.com/9gco/mein-discord-bot.git";
const DEFAULT_BRANCH = "main";
const FIRST_CHECK_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MIN = 10;

/** Zustandsdatei: zuletzt installierte package-lock.json. */
const LOCK_SHA_FILE = ".lock-sha";
/** Zustandsdatei: Update eingespielt, Start aber noch nicht bestätigt. */
const PENDING_FILE = ".pending-sha";
/** Zustandsdatei: der Bot war erfolgreich angemeldet. */
const BOOTED_FILE = ".booted";

export interface AutoUpdateSettings {
  repo: string;
  branch: string;
  /** Verzeichnis mit dem laufenden Build, meist das Arbeitsverzeichnis. */
  appDir: string;
  /** Ablage für die zuletzt synchronisierte Revision. */
  stateDir: string;
  intervalMin: number;
  firstDelayMs: number;
}

/**
 * Pterodactyl-Eggs benutzen fuer ihr eigenes `git pull` ebenfalls den Namen
 * `AUTO_UPDATE`, aber mit dem Wert "1". Wer im Panel also nach der Anleitung
 * des Eggs aufdreht, erwartet ein Update und bekommt keins. Deshalb werden
 * beide Schreibweisen akzeptiert.
 */
function isEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function readAutoUpdateSettings(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AutoUpdateSettings | undefined {
  if (!isEnabled(env["AUTO_UPDATE"])) return undefined;

  const intervalRaw = Number(env["AUTO_UPDATE_INTERVAL_MIN"] ?? DEFAULT_INTERVAL_MIN);
  const intervalMin = Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : DEFAULT_INTERVAL_MIN;

  return {
    repo: env["AUTO_UPDATE_REPO"]?.trim() || DEFAULT_REPO,
    branch: env["AUTO_UPDATE_BRANCH"]?.trim() || DEFAULT_BRANCH,
    appDir: cwd,
    stateDir: env["PERSISTENT_DATA_DIR"]?.trim() || resolve(cwd, ".data"),
    intervalMin,
    firstDelayMs: FIRST_CHECK_DELAY_MS,
  };
}

/**
 * `git ls-remote` liefert eine Zeile pro Ref, etwa
 * `<sha>\trefs/heads/main`. Gesucht ist der Branch, auf den deployed wird -
 * ein Auswählen des ersten Eintrags wäre falsch, weil das Repository auch
 * Tags und HEAD mitliefert.
 */
export function parseRemoteSha(stdout: string, branch: string): string | undefined {
  const wanted = `refs/heads/${branch}`;
  for (const line of stdout.split("\n")) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || ref !== wanted) continue;
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  }
  return undefined;
}

/**
 * Ob ein Update ansteht. Ohne bekannte Revision wird nichts geändert: beim
 * ersten Start nehmen wir an, dass der von Hand hochgeladene Stand zu main
 * passt, und schreiben nur die Revision auf. Sonst würde der erste Start
 * sofort ein Update auslösen.
 */
export function needsUpdate(synced: string | undefined, remote: string): boolean {
  if (!synced) return false;
  return synced !== remote;
}

async function run(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd: options.cwd,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    // Unter Windows heisst npm "npm.cmd", was execFile ohne Shell nicht findet.
    shell: process.platform === "win32",
  });
  return stdout;
}

function shaFile(settings: AutoUpdateSettings): string {
  return resolve(settings.stateDir, ".synced-sha");
}

/** Liest eine Zustandsdatei; fehlt sie, kommt `undefined` zurück. */
async function readState(file: string): Promise<string | undefined> {
  try {
    const trimmed = (await readFile(file, "utf8")).trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

async function writeState(file: string, value: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value, "utf8");
}

/**
 * Prüfsumme einer Datei. Wird für den Vergleich der `package-lock.json`
 * gebraucht: nur bei geänderter Lock-Datei lohnt ein `npm ci`.
 */
async function hashFile(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return undefined;
  }
}

async function readSyncedSha(settings: AutoUpdateSettings): Promise<string | undefined> {
  try {
    const raw = await readFile(shaFile(settings), "utf8");
    const trimmed = raw.trim();
    return /^[0-9a-f]{40}$/.test(trimmed) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function writeSyncedSha(settings: AutoUpdateSettings, sha: string): Promise<void> {
  const file = shaFile(settings);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${sha}\n`, "utf8");
}

async function fetchRemoteSha(settings: AutoUpdateSettings): Promise<string | undefined> {
  const stdout = await run("git", ["ls-remote", settings.repo, `refs/heads/${settings.branch}`]);
  return parseRemoteSha(stdout, settings.branch);
}

/**
 * Installiert Abhaengigkeiten nur, wenn sich die Lock-Datei geaendert hat.
 *
 * `npm ci` loescht `node_modules` und legt es neu an - auf der kleinen Platte
 * des Free-Tier-Hosts der teuerste Einzelposten (165 MB, davon 79 MB
 * ffmpeg-static). Bei einem Push, der nur Quelltext aendert, ist das reine
 * Verschwendung von Zeit und Platz.
 *
 * Der npm-Cache wird danach geleert: er waechst ueber mehrere Updates auf
 * mehrere hundert MB an und war die zweite Ursache fuer ENOSPC.
 */
async function installIfDependenciesChanged(settings: AutoUpdateSettings): Promise<void> {
  const lock = resolve(settings.appDir, "package-lock.json");
  const hash = await hashFile(lock);
  const marker = resolve(settings.stateDir, LOCK_SHA_FILE);

  if (hash && (await readState(marker)) === hash) {
    logger.info("Update: Abhaengigkeiten unveraendert, npm ci uebersprungen", {
      lock: hash.slice(0, 12),
    });
    return;
  }

  await run("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], { cwd: settings.appDir });
  if (hash) await writeState(marker, hash);

  // Bestmoeglich: ein Cache, der wieder gebraucht wird, wird naechstes Mal neu
  // gefuellt. Ohne das frisst er auf kleinen Platten den Platz fuer dist/.
  await run("npm", ["cache", "clean", "--force"], { cwd: settings.appDir }).catch(
    () => undefined,
  );
}

/** Vermerkt, dass ein Update eingespielt und der Start noch nicht bestaetigt ist. */
async function markPending(settings: AutoUpdateSettings, sha: string, prevSha: string): Promise<void> {
  await rm(resolve(settings.stateDir, BOOTED_FILE), { force: true });
  await writeState(resolve(settings.stateDir, PENDING_FILE), `${sha} ${prevSha}\n`);
}

/**
 * Setzt den Arbeitsbaum auf die neue Revision, baut im Anwendungsverzeichnis
 * und legt den vorherigen Stand als `dist.previous` zurueck.
 *
 * Der Arbeitsbaum wird mit `git reset --hard` exakt auf die neue Revision
 * gesetzt, statt Paketdateien einzeln zu kopieren. Grund: Das
 * Pterodactyl-NodeJS-Egg zieht bei jedem Start per `git pull` nach und bricht
 * ab, wenn versionierte Dateien lokal geaendert wurden. Ein sauberer Baum ist
 * Voraussetzung, nicht Kosmetik.
 *
 * Scheitert der Build, kommen Quellen und `dist/` auf den alten Stand
 * zurueck - der laufende Bot ist davon nicht betroffen, er laeuft ja bereits
 * im Speicher.
 */
async function buildInPlace(settings: AutoUpdateSettings, sha: string, prevSha: string): Promise<void> {
  const appDir = settings.appDir;

  logger.info("Update: Quellen im Projektverzeichnis holen", { sha });
  await run("git", ["fetch", "--depth", "1", "origin", settings.branch], { cwd: appDir });
  await run("git", ["reset", "--hard", sha], { cwd: appDir });

  await installIfDependenciesChanged(settings);

  const dist = resolve(appDir, "dist");
  const backup = `${dist}.previous`;
  await rm(backup, { recursive: true, force: true });
  await rename(dist, backup).catch(() => undefined);

  try {
    await run("npm", ["run", "build"], { cwd: appDir });
  } catch (err) {
    await rm(dist, { recursive: true, force: true });
    await rename(backup, dist).catch(() => undefined);
    await run("git", ["reset", "--hard", prevSha], { cwd: appDir }).catch(() => undefined);
    logger.error(err instanceof Error ? err : new Error(String(err)), {
      phase: "build",
      restored: prevSha,
    });
    throw err;
  }

  // Der alte Build bleibt liegen, bis main.js einen erfolgreichen Start
  // meldet. Erst dann ist das Update angenommen.
  await markPending(settings, sha, prevSha);
}

/**
 * Fallback ohne `.git` (etwa beim manuellen Hochladen eines Release-Archivs):
 * Klon nach /tmp, dort bauen und nur `dist/` zurueckkopieren. Teurer als der
 * In-Place-Weg, aber ohne Checkout gibt es keine Quellen vor Ort.
 */
async function buildViaStaging(settings: AutoUpdateSettings, sha: string): Promise<void> {
  const staging = resolve(tmpdir(), `mdb-update-${sha.slice(0, 8)}`);
  await rm(staging, { recursive: true, force: true });

  try {
    logger.info("Update: Repository holen", { sha, staging });
    await run("git", ["clone", "--depth", "1", "--single-branch", "--branch", settings.branch, settings.repo, staging]);
    await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: staging });
    await run("npm", ["run", "build"], { cwd: staging });

    const dist = resolve(settings.appDir, "dist");
    const backup = `${dist}.previous`;

    await rm(backup, { recursive: true, force: true });
    await rename(dist, backup).catch(() => undefined);

    try {
      await cp(resolve(staging, "dist"), dist, { recursive: true });
      for (const name of ["package.json", "package-lock.json"] as const) {
        await cp(resolve(staging, name), resolve(settings.appDir, name));
      }
    } catch (err) {
      // Tausch halbfertig: alten Stand zurückholen, sonst startet der Bot nach
      // dem Neustart mit einem unvollständigen dist/ gar nicht mehr.
      await rm(dist, { recursive: true, force: true });
      await rename(backup, dist).catch(() => undefined);
      throw err;
    }

    await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function buildAndSwap(settings: AutoUpdateSettings, sha: string, prevSha: string): Promise<void> {
  if (existsSync(resolve(settings.appDir, ".git"))) {
    await buildInPlace(settings, sha, prevSha);
  } else {
    await buildViaStaging(settings, sha);
  }
  await writeSyncedSha(settings, sha);
}

function logFailure(phase: string, err: unknown): void {
  // Der Logger nimmt ein Error als erstes Argument; Kontext wandert in die Meta.
  logger.error(err instanceof Error ? err : new Error(String(err)), { phase });
}

async function checkOnce(settings: AutoUpdateSettings): Promise<void> {
  // Nach einem Update wartet der Rollback in main.js auf die Bestätigung. Solange
  // der Marker liegt, wird nicht weiter aktualisiert - sonst zirkuliert der Bot
  // zwischen denselben Revisionen.
  const pending = await readState(resolve(settings.stateDir, PENDING_FILE));
  if (pending) {
    logger.warn("Update: letzter Start unbestaetigt, uebersprungen", { pending });
    return;
  }

  const remote = await fetchRemoteSha(settings);
  if (!remote) {
    logger.warn("Update: keine Revision vom Remote gelesen, übersprungen");
    return;
  }

  const synced = await readSyncedSha(settings);
  if (!synced) {
    logger.info("Update: erste Prüfung, aktuelle Revision wird festgehalten", { remote });
    await writeSyncedSha(settings, remote);
    return;
  }

  if (!needsUpdate(synced, remote)) {
    logger.debug("Update: bereits aktuell", { remote });
    return;
  }

  logger.info("Update: neue Revision gefunden, baue sie", { from: synced, to: remote });

  try {
    await buildAndSwap(settings, remote, synced);
  } catch (err) {
    // Der laufende Code bleibt unangetastet, der Bot macht ganz normal weiter.
    logFailure("build", err);
    return;
  }

  logger.info("Update eingespielt, starte neu. Falls der Bot nicht zurückkommt, im Panel auf Start klicken.");
  // Pterodactyl startet bei einem Absturz automatisch neu, das ist der einzige
  // Neustartweg ohne API-Zugriff. Exit-Code 1 signalisiert "Absturz".
  process.exit(1);
}

/**
 * Startet die regelmäßige Prüfung. Der erste Check läuft verzögert, damit ein
 * Neustart nach einem Update nicht sofort in eine Update-Schleife läuft.
 */
export function startAutoUpdate(settings: AutoUpdateSettings): void {
  const periodMs = settings.intervalMin * 60_000;

  // Anmeldung war erfolgreich: das Update gilt damit als bestätigt. main.js
  // lauscht auf genau diese Datei, um den Rollback abzubrechen.
  void writeState(resolve(settings.stateDir, BOOTED_FILE), `${Date.now()}\n`).catch(
    () => undefined,
  );

  setTimeout(() => {
    void checkOnce(settings).catch((err: unknown) => {
      logFailure("check", err);
    });
    setInterval(() => {
      void checkOnce(settings).catch((err: unknown) => {
        logFailure("check", err);
      });
    }, periodMs).unref();
  }, settings.firstDelayMs).unref();

  logger.info("Selbst-Update aktiv", {
    repo: settings.repo,
    branch: settings.branch,
    intervalMin: settings.intervalMin,
  });
}