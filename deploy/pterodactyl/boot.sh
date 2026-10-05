#!/usr/bin/env bash
#
# Einstiegspunkt fuer die gratis Pterodactyl-Hoster. Braucht im Container nur
# zwei Dateien: diese hier und mdb-release.zip, beide direkt in
# /home/container/. Der restliche Ordnerbaum entsteht durch Auspacken.
#
# Startup-Angabe im Panel:
#   bash /home/container/boot.sh
#
# Warum ein eigenes Skript: der Dateimanager im Panel laesst sich je nach
# Version nur mit einzelnen Dateien fuettern, und ein ZIP kann man dort je nach
# Panel-Version nicht entpacken. Also entpackt dieses Skript selbst.

set -euo pipefail

BASE_DIR="${BASE_DIR:-/home/container}"
APP_DIR="${APP_DIR:-$BASE_DIR/app}"
ZIP="$BASE_DIR/mdb-release.zip"

if [[ ! -f "$ZIP" ]]; then
  echo "FEHLER: $ZIP liegt nicht im Container."
  echo "Lade mdb-release.zip und boot.sh beide nach $BASE_DIR hoch."
  exit 1
fi

# Entpacken. Je nach Image ist entweder unzip oder python3 vorhanden, beides
# kann ZIP-Dateien lesen. Ohne beide gibt es keine Moeglichkeit, und dann muss
# der Ordnerbaum von Hand hochgeladen werden.
extract_zip() {
  if command -v unzip >/dev/null 2>&1; then
    unzip -oq "$ZIP" -d "$APP_DIR"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$ZIP" "$APP_DIR"
  else
    echo "FEHLER: weder 'unzip' noch 'python3' sind in diesem Image vorhanden."
    echo "Lade dann stattdessen den Ordner mdb-release manuell hoch."
    exit 1
  fi
}

# Nur auspacken, wenn noch kein Build da ist. Danach reicht dist/index.js als
# Merkmal, auch wenn der Bot zwischendurch zurueckgesetzt wurde.
if [[ ! -f "$APP_DIR/dist/index.js" ]]; then
  echo "==> Release entpacken nach $APP_DIR"
  mkdir -p "$APP_DIR"
  extract_zip
else
  echo "==> Release bereits vorhanden, uebersprungen"
fi

if [[ ! -f "$APP_DIR/deploy/pterodactyl/start.sh" ]]; then
  echo "FEHLER: $APP_DIR/deploy/pterodactyl/start.sh fehlt nach dem Entpacken."
  exit 1
fi

cd "$APP_DIR"
exec bash deploy/pterodactyl/start.sh