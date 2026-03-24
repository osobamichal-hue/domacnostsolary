#!/usr/bin/env bash
set -u

# HomeAPP server diagnostics (Ubuntu/RPi)
# Spusteni:
#   bash scripts/check-server.sh
# Volitelne:
#   SERVICE_NAME=homeapp APP_DIR=/home/administrator/nodeapp PORT=3000 bash scripts/check-server.sh

SERVICE_NAME="${SERVICE_NAME:-homeapp}"
APP_DIR="${APP_DIR:-/home/administrator/nodeapp}"
PORT="${PORT:-3000}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env.production}"
VENV_DIR="${VENV_DIR:-$APP_DIR/.venv}"

GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

ok_count=0
warn_count=0
fail_count=0

ok() {
  echo -e "${GREEN}OK${RESET}  $1"
  ok_count=$((ok_count + 1))
}

warn() {
  echo -e "${YELLOW}WARN${RESET} $1"
  warn_count=$((warn_count + 1))
}

fail() {
  echo -e "${RED}FAIL${RESET} $1"
  fail_count=$((fail_count + 1))
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

check_cmd() {
  local cmd="$1"
  local msg="$2"
  if have_cmd "$cmd"; then
    ok "$msg ($(command -v "$cmd"))"
  else
    fail "$msg (chybi prikaz '$cmd')"
  fi
}

check_node_version() {
  if ! have_cmd node; then
    fail "Node.js neni nainstalovany"
    return
  fi
  local v major
  v="$(node -v 2>/dev/null || true)"
  major="${v#v}"
  major="${major%%.*}"
  if [[ -n "$major" && "$major" -ge 20 ]]; then
    ok "Node verze $v (>= 20)"
  else
    fail "Node verze $v je nizsi nez 20 (projekt vyzaduje 20.x)"
  fi
}

check_python_pkgs() {
  local py="$1"
  "$py" - <<'PY'
import importlib.util, sys
mods = ["goodwe", "PIL", "numpy"]
missing = [m for m in mods if importlib.util.find_spec(m) is None]
if missing:
    print("MISSING:" + ",".join(missing))
    sys.exit(1)
print("OK")
PY
}

check_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "Soubor .env nenalezen: $ENV_FILE"
    return
  fi
  ok "Nalezen env soubor: $ENV_FILE"

  local required=(
    GOODWE_HOST
    DB_HOST
    DB_PORT
    DB_USER
    DB_PASSWORD
    DB_NAME
    PORT
    PYTHON_EXE
  )

  for k in "${required[@]}"; do
    if grep -Eq "^${k}=.+" "$ENV_FILE"; then
      if [[ "$k" == "DB_PASSWORD" ]]; then
        ok "$k je nastavene (skryto)"
      else
        ok "$k je nastavene"
      fi
    else
      fail "$k chybi nebo je prazdne v $ENV_FILE"
    fi
  done
}

check_venv_and_python() {
  if [[ -x "$VENV_DIR/bin/python" ]]; then
    ok "Python virtualenv existuje: $VENV_DIR"
    local out
    if out="$(check_python_pkgs "$VENV_DIR/bin/python" 2>&1)"; then
      ok "Python balicky goodwe/Pillow/numpy jsou nainstalovane ve venv"
    else
      fail "Chybi Python balicky ve venv: ${out#MISSING:}"
    fi
  else
    warn "VENV nenalezen: $VENV_DIR (zkus deploy skript znovu)"
  fi

  if have_cmd python3; then
    ok "Systemovy Python je dostupny ($(python3 --version 2>/dev/null))"
    if python3 -m venv --help >/dev/null 2>&1; then
      ok "python3-venv je dostupny"
    else
      fail "python3-venv chybi (apt install -y python3-venv)"
    fi
  else
    fail "python3 neni nainstalovany"
  fi
}

check_service() {
  if ! have_cmd systemctl; then
    fail "systemctl neni dostupny"
    return
  fi
  if systemctl list-unit-files | grep -q "^${SERVICE_NAME}\.service"; then
    ok "Služba ${SERVICE_NAME}.service existuje"
  else
    fail "Služba ${SERVICE_NAME}.service neexistuje"
    return
  fi

  if systemctl is-active --quiet "$SERVICE_NAME"; then
    ok "Služba $SERVICE_NAME běží"
  else
    fail "Služba $SERVICE_NAME neběží"
    warn "Logy: sudo journalctl -u $SERVICE_NAME -n 120 --no-pager"
  fi
}

check_app_files() {
  if [[ -d "$APP_DIR" ]]; then
    ok "Aplikační adresář existuje: $APP_DIR"
  else
    fail "Aplikační adresář chybí: $APP_DIR"
  fi

  local must=(
    "$APP_DIR/server/index.js"
    "$APP_DIR/python/fetch_runtime.py"
    "$APP_DIR/requirements.txt"
    "$APP_DIR/package.json"
  )
  local f
  for f in "${must[@]}"; do
    if [[ -f "$f" ]]; then
      ok "Nalezen soubor: $f"
    else
      fail "Chybí soubor: $f"
    fi
  done
}

check_health() {
  if ! have_cmd curl; then
    fail "curl neni nainstalovany"
    return
  fi
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    ok "API health endpoint odpovida: http://127.0.0.1:${PORT}/api/health"
  else
    fail "API health endpoint neodpovida na portu ${PORT}"
  fi
}

check_mysql_client() {
  if have_cmd mysql; then
    ok "MySQL/MariaDB klient je nainstalovany"
  else
    warn "mysql klient neni nainstalovany (neni kriticke pro beh Node)"
  fi
}

echo "=== HomeAPP server check (Ubuntu/RPi) ==="
echo "SERVICE_NAME=$SERVICE_NAME"
echo "APP_DIR=$APP_DIR"
echo "ENV_FILE=$ENV_FILE"
echo "PORT=$PORT"
echo

check_cmd git "Git je dostupny"
check_cmd npm "NPM je dostupny"
check_cmd curl "Curl je dostupny"
check_node_version
check_mysql_client
check_app_files
check_env_file
check_venv_and_python
check_service
check_health

echo
echo "=== Souhrn ==="
echo "OK:   $ok_count"
echo "WARN: $warn_count"
echo "FAIL: $fail_count"

if [[ "$fail_count" -gt 0 ]]; then
  exit 1
fi

exit 0
