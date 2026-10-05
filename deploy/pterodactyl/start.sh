#!/usr/bin/env bash
#
# Startskript fuer die gratis Pterodactyl-Hoster (Monkey Network, Elysian,
# HeavenCloud, VexaNode, Waifly, Darkless ...). Dort gibt es kein root, kein
# systemd und kein git - der Bot startet einfach ueber die Startup-Angabe des
# Panels.
#
# Startup-Angabe im Panel:
#   bash /home/container/deploy/pterodactyl/start.sh
#
# Wichtig: node_modules wird hier drinnen installiert, nicht hochgeladen.
# ffmpeg-static laedt sein Binary beim Installieren passend zur Plattform -
# ein von Windows hochgeladenes node_modules enthaelt nur ffmpeg.exe und der
# Bot stirbt bei der ersten Sprachausgabe. Deshalb hier im Container bauen.

set -euo pipefail

APP_DIR="${APP_DIR:-$PWD}"
DATA_DIR="${PERSISTENT_DATA_DIR:-$APP_DIR/data}"
LOCK_STAMP="$APP_DIR/.package-lock.sha256"

cd "$APP_DIR"

# --- Speicherlimit der Free-Tier-Container -------------------------------
# 256-MB-Container gibt es bei mehreren Anbietern. Node darf davon nicht den
# vollen Heap reservieren, sonst killt der Kernel den Bot per OOM-Killer.
# Pterodactyl setzt SERVER_MEMORY, sonst wird das cgroup-Limit gelesen.
detect_limit_mb() {
  local raw=""
  if [[ -n "${SERVER_MEMORY:-}" ]]; then
    echo "$SERVER_MEMORY"
    return
  fi
  if [[ -r /sys/fs/cgroup/memory.max ]]; then
    raw="$(cat /sys/fs/cgroup/memory.max)"
  elif [[ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]]; then
    raw="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
  fi
  [[ "$raw" =~ ^[0-9]+$ ]] || { echo 512; return; }
  # "max" bzw. ein astronomisch grosses Byte-Limit bedeutet: kein Limit.
  (( raw > 0 && raw < 68719476736 )) || { echo 512; return; }
  echo $(( raw / 1048576 ))
}

MEM_MB="$(detect_limit_mb)"
HEAP_MB=$(( MEM_MB * 60 / 100 ))
(( HEAP_MB < 128 )) && HEAP_MB=128
export NODE_OPTIONS="--max-old-space-size=${HEAP_MB}"
echo "==> Speicherlimit ${MEM_MB} MB, Node-Heap auf ${HEAP_MB} MB begrenzt"

mkdir -p "$DATA_DIR"

# --- Dependencies --------------------------------------------------------
lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ ! -d node_modules ]]; then
  echo "==> Erster Start: Dependencies werden installiert (kann 1-3 Minuten dauern)"
  npm ci --no-audit --no-fund
  printf '%s' "$lock_hash" > "$LOCK_STAMP"
elif [[ ! -f "$LOCK_STAMP" || "$(cat "$LOCK_STAMP")" != "$lock_hash" ]]; then
  echo "==> package-lock.json hat sich geaendert: Dependencies neu installieren"
  npm ci --no-audit --no-fund
  printf '%s' "$lock_hash" > "$LOCK_STAMP"
else
  echo "==> Dependencies passen, keine Neuinstallation"
fi

# --- Build ---------------------------------------------------------------
if [[ ! -f dist/index.js || src -nt dist ]]; then
  echo "==> TypeScript bauen"
  npm run build
  # typescript & Co. werden zur Laufzeit nicht gebraucht. Auf 512-MB-Disk-
  # Containern ist jeder MB wert.
  npm prune --omit=dev --no-audit --no-fund || true
else
  echo "==> dist/ ist aktuell"
fi

# --- Start ---------------------------------------------------------------
echo "==> Bot startet. Log: im Panel unter Console zu sehen."
exec node dist/index.js