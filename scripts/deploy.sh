#!/usr/bin/env bash
set -Eeuo pipefail

# HomeAPP deploy script (Ubuntu / Debian, systemd)
# Pouziti:
#   1) Pripadne uprav hodnoty natvrdo nize (REPO_URL, GOODWE_HOST, DB_* ...)
#   2) Spust:
#      bash scripts/deploy.sh

APP_DIR="${APP_DIR:-/home/administrator/nodeapp}"
REPO_URL="${REPO_URL:-https://github.com/osobamichal-hue/domacnostsolary.git}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-homeapp}"
APP_USER="${APP_USER:-$(id -un)}"
APP_GROUP="${APP_GROUP:-$(id -gn)}"
PORT="${PORT:-3000}"
NODE_ENV="${NODE_ENV:-production}"
PYTHON_VENV_DIR="${PYTHON_VENV_DIR:-$APP_DIR/.venv}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
INSTALL_LAN_WEB="${INSTALL_LAN_WEB:-0}" # 1 = doinstaluje python/requirements-lan.txt

GOODWE_HOST="${GOODWE_HOST:-192.168.1.14}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-10000}"
FEED_IN_CZK_PER_KWH="${FEED_IN_CZK_PER_KWH:-5.50}"

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-homeapp_user}"
DB_PASSWORD="${DB_PASSWORD:-mysql}"
DB_NAME="${DB_NAME:-homeapp_prod}"

LAN_WEB_ENABLED="${LAN_WEB_ENABLED:-0}"
LAN_WEB_BASE_URL="${LAN_WEB_BASE_URL:-}"
LAN_WEB_LOGIN_PATH="${LAN_WEB_LOGIN_PATH:-#/login}"
LAN_WEB_DATA_PATH="${LAN_WEB_DATA_PATH:-#/devices}"
LAN_WEB_ALT_PATH="${LAN_WEB_ALT_PATH:-#/}"
LAN_WEB_AUTO_ALT_DASHBOARD="${LAN_WEB_AUTO_ALT_DASHBOARD:-1}"
LAN_WEB_NODE_TIMEOUT_MS="${LAN_WEB_NODE_TIMEOUT_MS:-120000}"
LAN_WEB_USER="${LAN_WEB_USER:-admin}"
LAN_WEB_PASSWORD="${LAN_WEB_PASSWORD:-admin}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Chybi prikaz: $1" >&2
    exit 1
  }
}

ensure_python_venv() {
  if python3 -m venv --help >/dev/null 2>&1; then
    return 0
  fi

  echo "python3-venv chybi, doinstalovavam..."
  local py_minor_pkg
  py_minor_pkg="$(python3 - <<'PY'
import sys
print(f"python{sys.version_info.major}.{sys.version_info.minor}-venv")
PY
)"
  sudo apt-get update -y
  sudo apt-get install -y python3-venv "$py_minor_pkg" python3-pip || sudo apt-get install -y python3-venv python3-pip
}

node_major() {
  local v
  v="$("$NODE_BIN" -v 2>/dev/null || true)"
  v="${v#v}"
  echo "${v%%.*}"
}

require_non_empty() {
  local name="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    echo "Chybi povinna promenna: $name" >&2
    exit 1
  fi
}

echo "==> Kontrola zavislosti"
require_cmd sudo
require_cmd git
require_cmd curl
require_cmd python3
ensure_python_venv

if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
  echo "Node/NPM nenalezen. Instaluji..."
  sudo apt-get update -y
  sudo apt-get install -y nodejs npm
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm)"
fi

if [[ -n "$NODE_BIN" ]]; then
  NODE_MAJOR="$(node_major)"
  if [[ -z "${NODE_MAJOR:-}" || "$NODE_MAJOR" -lt 20 ]]; then
    echo "Node $( "$NODE_BIN" -v ) je starsi nez pozadovana verze 20.x." >&2
    echo "Na Ubuntu RPi doporucuji NodeSource (ARM64/ARMHF):" >&2
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -" >&2
    echo "  sudo apt-get install -y nodejs" >&2
    exit 1
  fi
fi

require_non_empty "REPO_URL" "$REPO_URL"
require_non_empty "GOODWE_HOST" "$GOODWE_HOST"

echo "==> Priprava adresare aplikace: $APP_DIR"
sudo mkdir -p "$(dirname "$APP_DIR")"
sudo chown -R "$APP_USER:$APP_GROUP" "$(dirname "$APP_DIR")"

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "==> Klonuji repozitar"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
echo "==> Aktualizuji kod ($BRANCH)"
git fetch origin
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> Instalace Node zavislosti"
"$NPM_BIN" ci --omit=dev

echo "==> Instalace Python zavislosti"
ensure_python_venv
python3 -m venv "$PYTHON_VENV_DIR"
"$PYTHON_VENV_DIR/bin/pip" install --upgrade pip
"$PYTHON_VENV_DIR/bin/pip" install -r requirements.txt

if [[ "$INSTALL_LAN_WEB" == "1" ]]; then
  echo "==> Instaluji LAN web zavislosti (Playwright)"
  "$PYTHON_VENV_DIR/bin/pip" install -r python/requirements-lan.txt
  "$PYTHON_VENV_DIR/bin/playwright" install chromium || true
fi

echo "==> Zapisuji .env: $ENV_FILE"
sudo mkdir -p "$(dirname "$ENV_FILE")"
sudo tee "$ENV_FILE" >/dev/null <<EOF
GOODWE_HOST=$GOODWE_HOST
POLL_INTERVAL_MS=$POLL_INTERVAL_MS
FEED_IN_CZK_PER_KWH=$FEED_IN_CZK_PER_KWH
PORT=$PORT
NODE_ENV=$NODE_ENV
PYTHON_EXE=$PYTHON_VENV_DIR/bin/python

DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME

LAN_WEB_ENABLED=$LAN_WEB_ENABLED
LAN_WEB_BASE_URL=$LAN_WEB_BASE_URL
LAN_WEB_LOGIN_PATH=$LAN_WEB_LOGIN_PATH
LAN_WEB_DATA_PATH=$LAN_WEB_DATA_PATH
LAN_WEB_ALT_PATH=$LAN_WEB_ALT_PATH
LAN_WEB_AUTO_ALT_DASHBOARD=$LAN_WEB_AUTO_ALT_DASHBOARD
LAN_WEB_NODE_TIMEOUT_MS=$LAN_WEB_NODE_TIMEOUT_MS
LAN_WEB_USER=$LAN_WEB_USER
LAN_WEB_PASSWORD=$LAN_WEB_PASSWORD
EOF
sudo chmod 600 "$ENV_FILE"
sudo chown "$APP_USER:$APP_GROUP" "$ENV_FILE"

echo "==> Vytvarim systemd sluzbu: /etc/systemd/system/$SERVICE_NAME.service"
sudo tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null <<EOF
[Unit]
Description=HomeAPP GoodWe dashboard
After=network-online.target mariadb.service mysql.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$APP_DIR
EnvironmentFile=-$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

echo "==> Reload + restart systemd"
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "==> Kontrola stavu sluzby"
sudo systemctl --no-pager --full status "$SERVICE_NAME" | sed -n '1,20p'

echo "==> Kontrola API health"
curl -fsS "http://127.0.0.1:$PORT/api/health" || {
  echo
  echo "Health check selhal. Posledni logy:"
  sudo journalctl -u "$SERVICE_NAME" -n 120 --no-pager
  exit 1
}
echo
echo "Deploy hotov."
