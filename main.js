/**
 * Einstiegspunkt fuer Hosts, die nur einen festen Startbefehl anbieten.
 *
 * Das Pterodactyl-NodeJS-Egg auf Monkey Network laesst den Startbefehl nicht
 * aendern. Es macht immer genau drei Dinge: `git pull`, `npm install` und
 * `node <Hauptdatei>`. Deshalb ist `main.js` die Hauptdatei statt
 * `dist/index.js` - dist/ ist nicht im Repository, weil es aus .gitignore
 * stammt und nach jedem `git pull` fehlen wuerde.
 *
 * Dieses Skript baut deshalb einmalig und startet danach den Bot. Der
 * Selbst-Update-Mechanismus in src/utils/autoUpdate.ts uebernimmt spaetere
 * Updates; dieser Pfad greift nur beim allerersten Start.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(ROOT, "dist", "index.js");

function run(command, args) {
  console.log(`[start] ${command} ${args.join(" ")}`);
  // Unter Windows heisst npm "npm.cmd", was execFile ohne Shell nicht findet.
  // Im Container ist npm ein normales Programm, die Shell schadet dort nicht.
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function ensureBuild() {
  if (existsSync(ENTRY)) {
    console.log("[start] dist/ vorhanden, starte ohne Build");
    return;
  }

  console.log("[start] dist/index.js fehlt, baue jetzt");

  if (existsSync(join(ROOT, ".git"))) {
    run("git", ["pull", "--ff-only"]);
  } else {
    console.log("[start] kein .git vorhanden - erwartet wird ein geklontes Repository");
  }

  // Das Egg installiert vorher mit `npm install --production`, also ohne
  // Dev-Dependencies. TypeScript gehoert aber zu den Dev-Dependencies und
  // waere beim Build nicht vorhanden. Deshalb hier ausdruecklich mit.
  run("npm", ["install", "--include=dev", "--no-audit", "--no-fund"]);

  run("npm", ["run", "build"]);
}

ensureBuild();
await import(pathToFileURL(ENTRY).href);