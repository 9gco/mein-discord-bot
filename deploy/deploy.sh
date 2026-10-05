#!/usr/bin/env bash
#
# Zieht den aktuellen Stand von main und startet den Bot neu.
# Laeuft auf der Oracle-VM, wird entweder per Hand oder von der
# GitHub-Actions-Workflow nach jedem Push auf main aufgerufen.
#
# Aufruf: sudo /opt/mein-discord-bot/deploy/deploy.sh

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/mein-discord-bot}"
DATA_DIR="${DATA_DIR:-/var/lib/mein-discord-bot}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-mein-discord-bot}"
LOCK_STAMP="${DATA_DIR}/.package-lock.sha256"

cd "${APP_DIR}"

echo "==> Stand von ${BRANCH} holen"
git fetch --prune origin "${BRANCH}"
git reset --hard "origin/${BRANCH}"

# Dependencies nur neu installieren, wenn sich das Lockfile geaendert hat.
# Sonst laedt der Bot bei jedem Push das 25-MB-ffmpeg-Binary neu.
lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ -d node_modules && -f "${LOCK_STAMP}" && "$(cat "${LOCK_STAMP}")" == "${lock_hash}" ]]; then
  echo "==> Dependencies unveraendert, npm ci uebersprungen"
else
  echo "==> Dependencies installieren"
  npm ci --no-audit --no-fund
  printf '%s' "${lock_hash}" > "${LOCK_STAMP}"
fi

echo "==> Build"
npm run build

# Der Bot darf als User 'bot' laufen, aber nicht die Dateien des Deployments
# veraendern – nach dem Build also wieder auf den Bot-Besitz zuruecksetzen.
chown -R bot:bot "${APP_DIR}/dist"

echo "==> ${SERVICE} neu starten"
systemctl restart "${SERVICE}"
systemctl --no-pager --lines=15 status "${SERVICE}" || true

echo "==> Fertig. Log: journalctl -u ${SERVICE} -f"
