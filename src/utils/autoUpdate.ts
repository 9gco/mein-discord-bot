import { execFile } from "node:child_process";
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
 * Bot nicht zerstört: Gebaut wird in einem Staging-Verzeichnis, und `dist/`
 * wird erst nach erfolgreichem Build getauscht.
 */

const execFileAsync = promisify(execFile);

const DEFAULT_REPO = "https://github.com/9gco/mein-discord-bot.git";
const DEFAULT_BRANCH = "main";
const FIRST_CHECK_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MIN = 10;

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

export function readAutoUpdateSettings(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AutoUpdateSettings | undefined {
  if (env["AUTO_UPDATE"] !== "true") return undefined;

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
  });
  return stdout;
}

function shaFile(settings: AutoUpdateSettings): string {
  return resolve(settings.stateDir, ".synced-sha");
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
 * Baut den neuen Stand in einem Staging-Verzeichnis und tauscht danach `dist/`
 * sowie die Paketdateien. package.json und package-lock.json müssen mitkommen,
 * weil das Startskript an deren Prüfsumme erkennt, ob `node_modules` neu
 * installiert werden muss – ohne sie liefe der neue Code gegen alte
 * Abhängigkeiten.
 */
async function buildAndSwap(settings: AutoUpdateSettings, sha: string): Promise<void> {
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
    await writeSyncedSha(settings, sha);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

function logFailure(phase: string, err: unknown): void {
  // Der Logger nimmt ein Error als erstes Argument; Kontext wandert in die Meta.
  logger.error(err instanceof Error ? err : new Error(String(err)), { phase });
}

async function checkOnce(settings: AutoUpdateSettings): Promise<void> {
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
    await buildAndSwap(settings, remote);
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