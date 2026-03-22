# Plán nasazení pomocí Git na Raspberry Pi (Ubuntu) po migraci na MySQL

Obecný popis aplikace HomeAPP (spuštění, API, konfigurace): viz **[README.md](README.md)** v kořeni projektu.

## Cíl

Cílem je mít jednoduchý a opakovatelný proces:
- push změn do repozitáře,
- `git pull` na RPi,
- restart služby (`systemd`),
- ověření, že aplikace běží.

### Co musí na serveru běžet (HomeAPP)

- **Node** — obsluha HTTP, WebSocket, **periodické dotazování střídače** a zápis do MySQL. Sběr dat probíhá i bez otevřeného webu; prohlížeč jen zobrazuje data z API.
- **Python 3** — skript `python/fetch_runtime.py` (knihovna GoodWe); cesta k interpreteru v konfiguraci (`pythonExe` / `PYTHON_EXE`).
- **MySQL/MariaDB** — schéma tabulek se vytvoří při **prvním startu** aplikace (žádné samostatné migrační CLI jako u některých frameworků).

Síť: stroj s HomeAPP musí dosáhnout na **IP střídače** v LAN (typicky UDP port **8899**). Volitelně druhý zdroj přes Playwright (`LAN_WEB_*`) — viz kořenový [`.env.example`](.env.example).

## 1) Repozitář a branch strategie

- Používej minimálně dvě větve: `main` (produkce) a `develop` (vývoj).
- Na Raspberry Pi nasazuj pouze z `main`.
- Před mergem do `main` vždy proveď test/build lokálně nebo v CI.

## 2) Příprava Raspberry Pi (Ubuntu)

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git
```

Podle použitého stacku:

```bash
# Node.js
sudo apt install -y nodejs npm

# Python
sudo apt install -y python3 python3-venv
```

Instalace MySQL serveru a klientských nástrojů:

```bash
sudo apt install -y mysql-server mysql-client
sudo systemctl enable mysql
sudo systemctl start mysql
sudo mysql_secure_installation
```

## 3) Deploy uživatel

```bash
sudo adduser deploy
sudo su - deploy
```

## 4) SSH klíč pro přístup do Git repozitáře

Na RPi (jako uživatel `deploy`):

```bash
ssh-keygen -t ed25519 -C "rpi-deploy"
```

- Veřejný klíč `~/.ssh/id_ed25519.pub` přidej do GitHub/GitLab jako Deploy Key (ideálně read-only).
- Ověř přístup:

```bash
ssh -T git@github.com
```

## 5) Klonování projektu

```bash
mkdir -p ~/apps && cd ~/apps
git clone git@github.com:TVUJ_UCET/TVUJ_REPO.git homeapp
cd homeapp
git checkout main
```

## 6) Konfigurace mimo Git

- Necommituj tajemství (`.env`, klíče, hesla) do repozitáře.
- Zkopíruj vzor: `cp .env.example .env` (nebo `.env.production` pro produkci) a vyplň hodnoty na cílovém stroji.
- Produkční soubor můžeš pojmenovat `.env.production` a načíst ho ve službě přes `EnvironmentFile=` (viz krok 7).
- Zajisti, aby citlivé soubory byly v `.gitignore`.
- Přidej databázové proměnné pro MySQL (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`) a **`GOODWE_HOST`** (IP střídače).

## 6.1) Inicializace MySQL databáze

Přihlas se do MySQL jako root a vytvoř databázi + dedikovaného uživatele:

```bash
sudo mysql -u root -p
```

```sql
CREATE DATABASE homeapp_prod CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'homeapp_user'@'localhost' IDENTIFIED BY 'silne_heslo';
GRANT ALL PRIVILEGES ON homeapp_prod.* TO 'homeapp_user'@'localhost';
FLUSH PRIVILEGES;
```

Do `.env` nebo `.env.production` nastav odpovídající údaje a ověř připojení aplikace.

## 6.2) Python závislosti (GoodWe)

V kořeni klonu (jako uživatel s oprávněním k projektu):

```bash
cd ~/apps/homeapp
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

V `.env` nastav např. `PYTHON_EXE=/home/deploy/apps/homeapp/.venv/bin/python`, aby služba používala stejný interpreter.

Volitelně **LAN web** (Playwright): `pip install -r python/requirements-lan.txt` a podle dokumentace Playwright i `playwright install` (chromium). Vyžaduje proměnné `LAN_WEB_USER`, `LAN_WEB_PASSWORD` a případně další z [`.env.example`](.env.example).

## 7) Spuštění aplikace přes systemd

Nejdřív jednorázově v adresáři projektu:

```bash
cd ~/apps/homeapp
npm ci --omit=dev
```

Vytvoř službu `/etc/systemd/system/homeapp.service` s minimálně těmito položkami:

- `User=deploy`
- `WorkingDirectory=/home/deploy/apps/homeapp`
- `ExecStart=/usr/bin/node /home/deploy/apps/homeapp/server/index.js`  
  (cestu k `node` ověř příkazem `which node`; alternativně `ExecStart=/usr/bin/npm start` s `PATH` vhodně nastaveným přes `Environment=`)
- `Restart=always`
- `EnvironmentFile=-/home/deploy/apps/homeapp/.env.production`  
  (případně `.env`; pomlčka znamená, že chybějící soubor nezhodí službu)

Aktivace služby:

```bash
sudo systemctl daemon-reload
sudo systemctl enable homeapp
sudo systemctl start homeapp
systemctl status homeapp
```

Ověření z jiného terminálu (nahraď host/port podle nasazení):

```bash
curl -sS http://127.0.0.1:3000/api/health | head
```

## 8) Manuální deploy postup

V projektu na RPi:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
```

```bash
npm ci --omit=dev
# Python venv (stejná cesta jako v PYTHON_EXE)
source .venv/bin/activate
pip install -r requirements.txt
```

HomeAPP **nevytváří schéma přes externí migrační příkaz** — tabulky se založí při startu Node, pokud chybí. Před aktualizací kódu z `git pull` je rozumné zálohovat databázi (změny schématu v novější verzi jsou řešeny v `server/db.js` při startu).

Záloha MySQL před aktualizací:

```bash
mysqldump -u homeapp_user -p homeapp_prod > ~/db-backups/homeapp_prod_$(date +%F_%H-%M).sql
```

Potom:

```bash
sudo systemctl restart homeapp
journalctl -u homeapp -n 100 --no-pager
```

## 9) Volitelně: deploy skript

Vytvoř `deploy.sh`, který provede kroky:
1. fetch/pull,
2. instalaci závislostí (`npm ci`, případně `pip install -r requirements.txt`),
3. volitelná záloha MySQL,
4. restart služby,
5. kontrolu logů (`journalctl`).

## 10) Rollback plán

Při problému po nasazení:

```bash
git log --oneline -n 5
git checkout <commit_hash>
sudo systemctl restart homeapp
```

Pokud je problém v DB schématu po migraci, proveď i databázový rollback:

```bash
# Obnova ze zálohy
mysql -u homeapp_user -p homeapp_prod < ~/db-backups/<backup_file>.sql
sudo systemctl restart homeapp
```

Po stabilizaci proveď opravu a nové nasazení přes `main`.

## 11) Minimum bezpečnosti

- Používej SSH klíče, ne hesla.
- Zapni firewall (`ufw`) a povol jen nutné porty.
- Preferuj reverse proxy (Nginx) a HTTPS.
- Omez MySQL přístup jen na localhost nebo privátní síť.
- Pravidelně rotuj DB hesla a testuj obnovu ze záloh.

