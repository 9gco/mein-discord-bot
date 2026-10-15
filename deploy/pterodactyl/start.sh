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

# --- Speicherplatz-Wartung ---------------------------------------------
# Die Free-Tier-Container haben rund 2 GB. Der npm-Cache waechst ueber
# Updates auf mehrere hundert MB und alte Staging-Bauten wiegen mit eigenem
# node_modules. Ist die Platte voll, endet npm mit
# "ENOSPC: no space left on device". Deshalb wird vor teueren Schritten
# geprueft und nach einem Fehlschlag am vollen Speicher einmal aufgeraeumt
# und wiederholt.
NPM_CACHE="${npm_config_cache:-${HOME:-/home/container}/.npm}"

free_mb() {
  df -Pm "$1" 2>/dev/null | awk 'NR==2 {print $4}'
}

cleanup_space() {
  local before after root
  before="$(free_mb "$APP_DIR")"
  rm -rf "$NPM_CACHE/_cacache" "$NPM_CACHE/_logs" "$NPM_CACHE/_tmp" \
         "$APP_DIR/node_modules/.cache" 2>/dev/null || true
  for root in "${TMPDIR:-/tmp}" "$(dirname "$APP_DIR")"; do
    find "$root" -maxdepth 1 -name 'mdb-update-*' -exec rm -rf {} \; 2>/dev/null || true
  done
  after="$(free_mb "$APP_DIR")"
  echo "==> Platte aufgeraeumt: ${before:-?} -> ${after:-?} MB frei"
}

ensure_space() {
  local needed="$1" label="$2" free
  free="$(free_mb "$APP_DIR")"
  if [[ -n "$free" && "$free" -lt "$needed" ]]; then
    echo "==> nur ${free} MB frei (< ${needed} MB), raeume vor ${label} auf"
    cleanup_space
  fi
}

# Fuehrt den Befehl mit laufender Ausgabe aus. Scheitert er mit ENOSPC, wird
# einmal aufgeraeumt und wiederholt; alles andere kommt unveraendert zurueck.
run_with_space_retry() {
  local label="$1" status=0 log
  shift
  log="${TMPDIR:-/tmp}/mdb-cmd-$$.log"
  "$@" 2>&1 | tee "$log" || status=$?
  if [[ $status -eq 0 ]]; then rm -f "$log"; return 0; fi
  if grep -qiE 'ENOSPC|no space left on device' "$log"; then
    rm -f "$log"
    echo "==> ${label} am vollen Speicher gescheitert: raeume auf und versuche erneut"
    cleanup_space
    "$@"
    return $?
  fi
  rm -f "$log"
  return $status
}

mkdir -p "$DATA_DIR"

# --- Dependencies --------------------------------------------------------
lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ ! -d node_modules ]]; then
  echo "==> Erster Start: Dependencies werden installiert (kann 1-3 Minuten dauern)"
  ensure_space 300 "npm ci"
  run_with_space_retry "npm ci" npm ci --no-audit --no-fund
  printf '%s' "$lock_hash" > "$LOCK_STAMP"
elif [[ ! -f "$LOCK_STAMP" || "$(cat "$LOCK_STAMP")" != "$lock_hash" ]]; then
  echo "==> package-lock.json hat sich geaendert: Dependencies neu installieren"
  ensure_space 300 "npm ci"
  run_with_space_retry "npm ci" npm ci --no-audit --no-fund
  printf '%s' "$lock_hash" > "$LOCK_STAMP"
else
  echo "==> Dependencies passen, keine Neuinstallation"
fi

# --- Build ---------------------------------------------------------------
if [[ ! -f dist/index.js || src -nt dist ]]; then
  echo "==> TypeScript bauen"
  ensure_space 120 "Build"
  run_with_space_retry "npm run build" npm run build
  # typescript & Co. werden zur Laufzeit nicht gebraucht. Auf 512-MB-Disk-
  # Containern ist jeder MB wert.
  npm prune --omit=dev --no-audit --no-fund || true
else
  echo "==> dist/ ist aktuell"
fi

# --- Start ---------------------------------------------------------------
echo "==> Bot startet. Log: im Panel unter Console zu sehen."
exec node dist/index.js