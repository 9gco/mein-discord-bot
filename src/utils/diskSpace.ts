import { statfsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "./logger.js";

/**
 * Speicherplatz-Wartung fuer die 2-GB-Free-Tier-Container.
 *
 * Zwei Dinge fressen dort den Platz: der npm-Cache, der ueber mehrere
 * Updates auf mehrere hundert MB waechst, und verlassene Staging-Bauten des
 * Selbst-Updates mit eigenem node_modules (rund 165 MB). Ist die Platte voll,
 * endet jeder npm-Aufruf mit "ENOSPC: no space left on device" - auf den
 * Free-Tier-Hostern die haeufigste Abbruchursache.
 *
 * Deshalb zwei Mechanismen:
 *   1. Vor einem teuren Schritt wird der freie Platz geprueft und bei
 *      Bedarf aufgeraeumt.
 *   2. Schlaegt ein Schritt trotzdem ab, wird einmal aufgeraeumt und der
 *      Schritt wiederholt.
 *
 * Aufgeraeumt wird nur Wiederbeschaffbares: npm-Cache, npm-Logs, alte
 * Staging-Klons, `node_modules/.cache`. `dist.previous` bleibt liegen, der
 * Rollback-Waechter braucht es.
 */

/** Freier Platz, den `npm ci`/`npm install` vorfinden muss. */
export const INSTALL_MARGIN_MB = 300;
/** Freier Platz fuer den TypeScript-Build. */
export const BUILD_MARGIN_MB = 120;
/** Freier Platz fuer einen zweiten Klon samt eigenem node_modules. */
export const STAGING_MARGIN_MB = 400;

/** Freier Platz in MB auf der Platte von `dir`; unklaerbar, wenn nicht erfragbar. */
export function freeSpaceMb(dir: string): number | undefined {
  try {
    const { bavail, bsize } = statfsSync(dir);
    return Math.round((bavail * bsize) / 1024 / 1024);
  } catch {
    return undefined;
  }
}

/**
 * Erkennt "Platte voll" am Fehler. `execFile` haengt den stderr-Text des
 * Kindprozesses an das Error-Objekt, dort steht "ENOSPC" drin. Bei
 * `stdio: inherit` (main.js) fehlt dieser Text - dort dient der freie Platz
 * nach dem Fehlschlag als Merkmal, siehe `shouldRetryForSpace`.
 */
export function isNoSpaceError(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    const { stderr } = err as { stderr?: unknown };
    if (typeof stderr === "string") parts.push(stderr);
    else if (Buffer.isBuffer(stderr)) parts.push(stderr.toString("utf8"));
  } else {
    parts.push(String(err));
  }
  return /ENOSPC|no space left on device/i.test(parts.join("\n"));
}

/** npm-Cache-Verzeichnis: `npm_config_cache` hat Vorrang, sonst `~/.npm`. */
function npmCacheDir(): string {
  return (
    process.env["npm_config_cache"] || process.env["NPM_CONFIG_CACHE"] || join(homedir(), ".npm")
  );
}

export interface CleanupOptions {
  /** Projektverzeichnis; dort wird `node_modules/.cache` gesucht. */
  appDir?: string;
  /** Staging-Verzeichnis eines laufenden Baus, das nicht angefasst wird. */
  keep?: string;
}

/**
 * Leert alles Wiederbeschaffbare und protokolliert, wieviel Platz das
 * gebracht hat. Fehlschlage hier sind kein Fehler: aufgeraeumt wird nach
 * Moeglichkeit, der Rest ergibt der erneute Versuch.
 */
export async function cleanupDiskSpace(options: CleanupOptions = {}): Promise<void> {
  const before = options.appDir ? freeSpaceMb(options.appDir) : undefined;
  const cache = npmCacheDir();

  const targets = [
    join(cache, "_cacache"),
    join(cache, "_logs"),
    join(cache, "_tmp"),
    ...(options.appDir ? [join(options.appDir, "node_modules", ".cache")] : []),
  ];

  // Verlassene Staging-Klons des Selbst-Updates. Sie entstehen, wenn ein
  // Build abbricht, bevor die finally-Bereinigung laeuft. Gesucht wird in
  // beiden Wurzeln, weil der Klon je nach Umgebung in HOME oder in /tmp
  // liegt.
  for (const root of new Set([tmpdir(), homedir()])) {
    try {
      for (const entry of await readdir(root)) {
        if (!entry.startsWith("mdb-update-")) continue;
        const path = join(root, entry);
        if (options.keep && path === options.keep) continue;
        targets.push(path);
      }
    } catch {
      /* Wurzel nicht lesbar - dann eben nicht dort aufrumen. */
    }
  }

  for (const target of targets) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }

  if (options.appDir) {
    logger.info("Platte: Zwischenspeicher geleert", {
      beforeMb: before,
      afterMb: freeSpaceMb(options.appDir),
    });
  }
}

/**
 * Vor einem teuren Schritt pruefen: reicht der freie Platz? Unterhalb der
 * Marke wird aufgeraeumt. Der Aufruf selbst ist billig, deshalb lieber
 * einmal zu oft - Loeschen von Cache und Logs schadet nie.
 */
export async function ensureFreeSpace(dir: string, neededMb: number, label: string): Promise<void> {
  const free = freeSpaceMb(dir);
  if (free === undefined || free >= neededMb) return;
  logger.warn(`Platte: nur ${free} MB frei - raeume vor ${label} auf`, { neededMb });
  await cleanupDiskSpace({ appDir: dir });
}

/**
 * Fuehrt `fn` aus und wiederholt ihn einmal, wenn die Platte voll ist.
 *
 * Der erste Fehlschlag mit vollem Platz ist kein Endzustand: der Cache und
 * die Reste des abgebrochenen Laufs sind weg, dann passt `npm ci` meist
 * wieder. Der zweite Fehlschlag wird weitergeworfen - der laufende Bot ist
 * davon nie betroffen, er laeuft ja bereits im Speicher.
 */
export async function withSpaceRetry<T>(
  label: string,
  dir: string,
  fn: () => Promise<T>,
  cleanup: CleanupOptions = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!shouldRetryForSpace(err, dir)) throw err;

    logger.warn(`Platte: ${label} abgebrochen - raeume auf und versuche es erneut`, {
      freeMb: freeSpaceMb(dir),
      error: err instanceof Error ? err.message : String(err),
    });
    await cleanupDiskSpace({ appDir: cleanup.appDir ?? dir, keep: cleanup.keep });
    return await fn();
  }
}

/**
 * ENOSPC im Fehler ist das klare Signal. Zusatzlich zaehlt sehr wenig freier
 * Platz: bei `stdio: inherit` bleibt der npm-Text am Fehlerobjekt verloren,
 * und npm meldet ENOSPC ausgerechnet dann, wenn der Platz knapp war.
 */
function shouldRetryForSpace(err: unknown, dir: string): boolean {
  if (isNoSpaceError(err)) return true;
  const free = freeSpaceMb(dir);
  return free !== undefined && free < INSTALL_MARGIN_MB;
}
