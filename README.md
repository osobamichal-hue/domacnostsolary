# HomeAPP (GoodWe)

Webový přehled a statistiky pro střídač **GoodWe** (SEMS / lokální síť): živá data, ukládání vzorků do **MySQL**, REST API, WebSocket, export XLS.

---

## Požadavky

| Komponenta | Poznámka |
|------------|----------|
| **Node.js** | 20.x (`package.json` engines) |
| **npm** | 10+ |
| **MySQL / MariaDB** | Lokální nebo v síti; schéma se vytvoří při startu |
| **Python 3** | Pro `python/fetch_runtime.py` (čtení střídače); cesta lze nastavit v konfiguraci |

---

## Rychlý start

```bash
cd HomeAPP
npm install
copy .env.example .env
# Upravte .env — zejména GOODWE_HOST, DB_*, případně PORT
npm start
```

Aplikace naslouchá na **`http://localhost:3000`** (nebo na hodnotě `PORT` v `.env`).

- Přihlášení: `/login.html` — první uživatel lze založit v **Nastavení** (po přihlášení), pokud je registrace povolena v kódu.
- Statické soubory a API obsluhuje **stejný** Node proces — doporučený způsob je otevírat UI přímo z tohoto portu.

---

## Konfigurace

### Proměnné prostředí (`.env`)

Vzor: [`.env.example`](.env.example).

| Proměnná | Význam |
|----------|--------|
| `GOODWE_HOST` | IP střídače v LAN (UDP komunikace z Python skriptu) |
| `POLL_INTERVAL_MS` | Interval dotazování (min. 5000 ms; v UI lze přepsat) |
| `FEED_IN_CZK_PER_KWH` | Výkupní cena za kWh pro odhad příjmu |
| `PORT` | Port HTTP serveru (změna vyžaduje restart) |
| `DB_*` | Připojení k MySQL (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) |
| `PYTHON_EXE` | Volitelně příkaz pro Python (výchozí `python`) |

### Trvalé nastavení v UI

Ukonfigurované hodnoty z rozhraní **Nastavení** se ukládají do **`data/app-config.json`** a mají přednost nad výchozími hodnotami z `.env` (viz `server/configStore.js`).

---

## Architektura (přehled)

```
[Prohlížeč] ←→ Express (REST + statické soubory) + WebSocket
                    │
                    ├── Poller (interval) → Python fetch_runtime.py → GoodWe
                    └── MySQL (readings, uživatelé, session)
```

- **Živá data**: Python skript vrací JSON; server ho zapisuje do DB a broadcastuje přes WS.
- **Autentizace**: cookie session (`homeapp_session`), chráněné cesty vyžadují přihlášení.
- **CORS**: povolené s `credentials` kvůli volání API z jiného originu (viz níže).

### Sběr dat bez otevřeného webu

Dotazování střídače běží **uvnitř Node procesu** (`setInterval` po startu serveru). **Prohlížeč ani otevřená stránka nejsou potřeba** — stačí běžící server (např. jako služba pod `systemd`). Data se ukládají do MySQL i když není připojen žádný klient; WebSocket jen doručuje nové vzorky těm, kdo mají UI otevřené.

Kromě Node musí být dostupný **Python** s závislostmi z `requirements.txt` a síťový dosah na **IP střídače** (`GOODWE_HOST` / Nastavení). Volitelný LAN web (Playwright) má další závislosti — viz `python/requirements-lan.txt` a proměnné `LAN_WEB_*` v [`.env.example`](.env.example).

### Přehled — barvy hodnot Síť a Zátěž

Na hlavním přehledu se barva číselné hodnoty mění podle velikosti:

| Prvek | Pravidlo |
|--------|----------|
| **Síť** | Záporný výkon (odběr ze sítě) je zvýrazněn červeně. |
| **Zátěž** | Podle absolutní hodnoty ve wattech: do 800 W zelená, do 1,5 kW žlutá, do 2,2 kW oranžová, od 2,2 kW výše červená. |

---

## Frontend a Apache / AMPPS

Pokud se HTML servíruje z **Apache** (např. `http://localhost/HomeAPP/public/`) a Node běží na **:3000**, relativní cesta `/api/...` míří na Apache, ne na Node — API vrátí HTML (404) místo JSON.

Řešení:

1. **Preferované:** otevírat UI z Node: `http://localhost:3000/`.
2. Nebo použít **`public/api-base.js`**: automaticky nastaví základ API na `http(s)://host:3000` při cestách obsahujících `HomeAPP` nebo `/public/*.html` na portu 80/443.
3. Nebo ručně: `localStorage.setItem('homeapp_api_base', 'http://127.0.0.1:3000')` a obnovit stránku.
4. **localhost vs 127.0.0.1:** uložená adresa API se normalizuje, aby se stejný server na portu 3000 nevolal jako jiný origin (jinak selže přihlášení / cookies).

Soubor **`api-base.js`** musí být načten před skripty používajícími `apiFetch` (přihlášení má náhradní definici, pokud by se skript nenačetl).

---

## REST API (přehled)

Všechny cesty kromě veřejných vyžadují platnou session cookie (kromě `GET /api/health` a auth endpointů bez `/api/auth/me`).

| Metoda | Cesta | Popis |
|--------|--------|--------|
| `GET` | `/api/health` | Stav serveru + konfigurace |
| `POST` | `/api/auth/login` | Přihlášení (JSON: `username`, `password`) |
| `POST` | `/api/auth/logout` | Odhlášení |
| `POST` | `/api/auth/register` | Registrace uživatele |
| `GET` | `/api/auth/me` | Aktuální uživatel |
| `GET` | `/api/config` | Konfigurace (střídač, interval, cena) |
| `PUT` | `/api/config` | Úprava konfigurace |
| `GET` | `/api/live` | Poslední živý záznam (JSON) |
| `GET` | `/api/series` | Časová řada (limit) |
| `GET` | `/api/series-range?range=day\|month\|year` | Agregovaná řada (den = 5min buckety) |
| `GET` | `/api/stats?range=day\|month\|year` | Agregované statistiky za období |
| `GET` | `/api/stats/snapshot` | Rychlé přehledy (rok, celé období, dnes) |
| `GET` | `/api/stats/breakdown?granularity=years\|months\|days` | Rozpad podle kalendáře |
| `GET` | `/api/stats/monthly-matrix` | Měsíční matice po letech (jako Excel) |
| `GET` | `/api/export/xls?range=...` | Export XLS |

---

## NPM skripty

| Příkaz | Popis |
|--------|--------|
| `npm start` / `npm run dev` | Spuštění serveru |
| `npm run import:ha` | Import historie z Home Assistant (viz skript) |
| `npm run import:ha:dry` | Stejné bez zápisu |

---

## Data

- **MySQL** — tabulka `readings` (časové řady), uživatelé a session.
- Složka **`data/`** — `app-config.json`, případně další runtime soubory.
- Volitelná migrace ze starého SQLite při startu DB (viz `server/db.js`).

---

## Nasazení na server (Raspberry Pi atd.)

Obecný postup s **Git**, **MySQL** a **systemd** je popsán v souboru **[nasazeni.md](nasazeni.md)**.

---

## Android (APK)

Klientská aplikace pro telefon je ve složce **`android/`** — sestavení a chování je popsáno v **[android/README.md](android/README.md)**.

---

## Řešení problémů

| Příznak | Možná příčina |
|---------|----------------|
| `JSON.parse` / „neplatná odpověď“ na statistikách | API nevolá Node (Apache) — viz sekce AMPPS výše |
| Nelze se přihlásit po změně URL | `localStorage.removeItem('homeapp_api_base')`, pak otevřít z `http://localhost:3000` |
| `EADDRINUSE :3000` | Jiný proces na portu — ukončit nebo změnit `PORT` |
| Python / GoodWe chyba | Ověřit `GOODWE_HOST`, firewall, že Python najde závislosti pro `fetch_runtime.py` |
| Žádné nové záznamy v DB / přehled „zamrzne“ | Zkontrolovat, že běží **Node** (`systemctl status` na serveru); prohlížeč nemusí být otevřený |

---

## Licence

Soukromý projekt (`version: 0.0.0`, `private: true`).
