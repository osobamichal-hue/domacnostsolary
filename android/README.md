# HomeAPP — Android APK

Nativní obal kolem **WebView**: zobrazuje stejné HTML/CSS/JS jako webová aplikace z Node serveru (žádný samostatný „prohlížeč“ s adresním řádkem; běžný postup pro interní nástroje).

## Funkce

- **Domácí síť** a **internet** — hostitel/IP + port (výchozí `3000`).
- **Priorita** — přepínač „Nejdřív zkusit domácí adresu“: aplikace volá `GET /api/health` na kandidátech v pořadí a použije první odpovídající server.
- **Přihlášení** — volitelné uložení uživatelského jména a hesla (**EncryptedSharedPreferences**). Při otevření `login.html` se nejdřív ověří session (`/api/auth/me`), jinak se provede `POST /api/auth/login` a přesměrování na `/`.
- Horní lišta: **Obnovit stránku**, **Nastavení serveru**.

## Sestavení

1. Nainstalujte [Android Studio](https://developer.android.com/studio) (včetně Android SDK).
2. **File → Open** a vyberte složku `android/`.
3. Po synchronizaci Gradle: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
4. Výstup: `app/build/outputs/apk/debug/app-debug.apk` (nebo release po podpisu).

Projekt cílí na **minSdk 26**, **compileSdk 34**.

## Nasazení na telefon

- Přeneste APK (USB, cloud) a povolte instalaci z neznámých zdrojů dle verze Androidu.
- Na serveru musí být dostupný Node HomeAPP (viz kořenový `README.md`) a z internetu typicky **přesměrování portu** na routeru + případně HTTPS (reverse proxy).

## Poznámky

- **HTTP** v lokální síti je povolen (`usesCleartextTraffic` + `network_security_config`).
- **Dvě různé adresy** = dva různé originy: session cookie se vztahuje k hostiteli, který právě funguje. Při přepnutí mezi LAN a veřejnou IP může být potřeba znovu projít přihlášením (stejně jako v prohlížeči), pokud se nepoužije jednotná doména.
- Pro **HTTPS** s vlastním certifikátem může být nutné certifikát nainstalovat do úložiště uživatele zařízení (viz `res/xml/network_security_config.xml`).
