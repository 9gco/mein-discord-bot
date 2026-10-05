#!/usr/bin/env bash
#
# Einmalige Einrichtung einer frischen Oracle-Cloud-VM (Ubuntu 24.04).
# Danach laeuft der Bot als systemd-Service und zieht seine Updates selbst.
#
# Aufruf:
#   git clone https://github.com/9gco/mein-discord-bot.git
#   sudo bash mein-discord-bot/deploy/setup-vm.sh
#
# Danach die Werte unten in /opt/mein-discord-bot/.env eintragen und
#   sudo systemctl restart mein-discord-bot

set -euo pipefail

APP_USER="bot"
APP_DIR="/opt/mein-discord-bot"
DATA_DIR="/var/lib/mein-discord-bot"
REPO="https://github.com/9gco/mein-discord-bot.git"
BRANCH="main"
REQUIRED_NODE_MAJOR=22

if [[ "${EUID}" -ne 0 ]]; then
  echo "Bitte mit sudo ausfuehren." >&2
  exit 1
fi

echo "==> Basis-Pakete"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git jq less tar

# Node aus dem NodeSource-Repo statt aus den Ubuntu-Repos – dort steht in
# 24.04 noch Node 18, der Bot braucht 22.
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -v | sed 's/^v\([0-9][0-9]*\).*/\1/')"
fi
if [[ "${node_major}" -lt "${REQUIRED_NODE_MAJOR}" ]]; then
  echo "==> Node ${REQUIRED_NODE_MAJOR} installieren (aktuell: ${node_major})"
  curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "==> Node $(node -v) ist bereits da"
fi
node --version
npm --version

echo "==> System-User ${APP_USER}"
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${APP_USER}" \
    --shell /usr/sbin/nologin "${APP_USER}"
fi

echo "==> Verzeichnisse"
install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}" "${DATA_DIR}"

echo "==> Repository"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" remote set-url origin "${REPO}"
else
  # In ein leeres Zielverzeichnis klonen, sonst meckert git wegen ".git".
  rmdir "${APP_DIR}" 2>/dev/null || true
  git clone --branch "${BRANCH}" --depth 1 "${REPO}" "${APP_DIR}"
fi

echo "==> Dependencies und Build"
cd "${APP_DIR}"
npm ci --no-audit --no-fund
npm run build
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}" "${DATA_DIR}"

echo "==> .env anlegen"
if [[ -f "${APP_DIR}/.env" ]]; then
  echo "    .env existiert bereits – unveraendert gelassen."
else
  cat > "${APP_DIR}/.env" <<'ENVEOF'
# Zugangsdaten des Bots. Werte aus dem Railway-Dashboard uebernehmen.
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=

# Laufzeitdaten (Verify-Konfiguration, Tickets) liegen ausserhalb des Code-
# Verzeichnisses, damit ein Update sie nicht loescht.
PERSISTENT_DATA_DIR=/var/lib/mein-discord-bot

PORT=3000
LOG_LEVEL=info
ENVEOF
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
  chmod 600 "${APP_DIR}/.env"
  echo "    ${APP_DIR}/.env angelegt – bitte Werte eintragen."
fi

echo "==> systemd-Service"
install -m 644 "${APP_DIR}/deploy/mein-discord-bot.service" \
  /etc/systemd/system/mein-discord-bot.service
systemctl daemon-reload
systemctl enable mein-discord-bot.service

# Ohne Zugangsdaten kann der Bot nicht starten; das soll hier nicht als Fehler
# enden, sondern als Hinweis.
if grep -qE '^DISCORD_TOKEN=.+' "${APP_DIR}/.env" 2>/dev/null; then
  echo "==> Service starten"
  systemctl restart mein-discord-bot.service
else
  echo "==> .env hat noch kein DISCORD_TOKEN – Service wurde nicht gestartet."
  echo "    Werte eintragen, dann: sudo systemctl restart mein-discord-bot"
fi

cat <<'DONE'

Einrichtung fertig.

  Werte eintragen:   sudo nano /opt/mein-discord-bot/.env
  Bot starten:       sudo systemctl restart mein-discord-bot
  Log live:          journalctl -u mein-discord-bot -f
  Status:            systemctl status mein-discord-bot
  Späteres Update:   sudo /opt/mein-discord-bot/deploy/deploy.sh

Wichtig: Wenn der Bot parallel auf Railway laeuft, melden sich zwei Clients
mit demselben Token bei Discord an. Railway vor dem Start des VM-Bots
stoppen, sonst reagieren beide gleichzeitig auf Befehle und Voice-Events.
DONE
