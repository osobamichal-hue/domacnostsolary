# Plán nasazení pomocí Git na Raspberry Pi (Ubuntu) po migraci na MySQL

## Cíl

Cílem je mít jednoduchý a opakovatelný proces:
- push změn do repozitáře,
- `git pull` na RPi,
- restart služby (`systemd`),
- ověření, že aplikace běží.

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
- Produkční konfiguraci drž v souboru `.env.production`.
- Zajisti, aby citlivé soubory byly v `.gitignore`.
- Přidej databázové proměnné pro MySQL (např. `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`).

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

Do `.env.production` nastav odpovídající údaje a ověř připojení aplikace.

## 7) Spuštění aplikace přes systemd

Vytvoř službu `/etc/systemd/system/homeapp.service` s minimálně těmito položkami:
- `User=deploy`
- `WorkingDirectory=/home/deploy/apps/homeapp`
- `ExecStart=` podle stacku (např. `npm run start` nebo `python3 app.py`)
- `Restart=always`
- `EnvironmentFile=/home/deploy/apps/homeapp/.env.production`

Aktivace služby:

```bash
sudo systemctl daemon-reload
sudo systemctl enable homeapp
sudo systemctl start homeapp
systemctl status homeapp
```

## 8) Manuální deploy postup

V projektu na RPi:

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
```

Podle stacku nainstaluj závislosti:

```bash
# Node.js
npm ci --omit=dev

# Python
pip install -r requirements.txt
```

Před migracemi doporučení:
- vytvoř zálohu databáze,
- spusť migrace s minimálním výpadkem,
- až po úspěšných migracích restartuj službu.

Záloha MySQL před migrací:

```bash
mysqldump -u homeapp_user -p homeapp_prod > ~/db-backups/homeapp_prod_$(date +%F_%H-%M).sql
```

Spuštění migrací (příklady podle frameworku):

```bash
# Django
python manage.py migrate --noinput

# Laravel
php artisan migrate --force

# Sequelize (Node.js)
npx sequelize-cli db:migrate
```

Potom:

```bash
sudo systemctl restart homeapp
journalctl -u homeapp -n 100 --no-pager
```

## 9) Volitelně: deploy skript

Vytvoř `deploy.sh`, který provede kroky:
1. fetch/pull,
2. instalaci závislostí,
3. migrace,
4. restart služby,
5. kontrolu logů.

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

