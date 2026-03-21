Technická specifikace pro lokální vyčítání dat ze střídačů GoodWe

Tento dokument slouží jako standardizovaný pracovní postup (SOP) pro konfiguraci a integraci střídačů GoodWe do systémů energetického managementu (Home Assistant apod.) prostřednictvím lokální sítě.

1. Přehled rozhraní a síťová konfigurace

Metoda komunikace se střídači GoodWe je definována jako Local Polling (lokální dotazování). Tato integrace nevyžaduje cloudové připojení, čímž zajišťuje vyšší úroveň soukromí a rychlejší odezvu.

* IoT Class: Local Polling
* Protokol: UDP
* Port: 8899

Pro úspěšnou integraci musí střídač naslouchat na UDP portu 8899 v rámci lokální sítě. Funkčnost síťové komunikace lze ověřit pomocí oficiálních aplikací výrobce PvMaster nebo SolarGo. Pokud tyto aplikace se střídačem v rámci sítě komunikují, je lokální rozhraní aktivní.

2. Kompatibilita hardwaru a požadavky na firmware

Integrace je primárně určena pro následující produktové řady:

* ET, EH, BT, BH, ES, EM, DT, MS, D-NS, XS a BP.

Technická poznámka: Ačkoliv jsou výše uvedené řady oficiálně podporovány, integrace může fungovat i na jiných modelech GoodWe, pokud naslouchají na portu 8899 a odpovídají na standardní komunikační protokoly výrobce.

Kritické upozornění k firmwaru:

Pokud komunikace přes UDP selhává i u podporovaného modelu, je nezbytné prověřit verzi ARM firmwaru.

* Specifikace požadavku: Při kontaktu s technickou podporou výrobce musíte výslovně žádat o upgrade ARM firmwaru, nikoliv pouze o běžný firmware střídače. Bez aktuálního ARM firmwaru nebude střídač na UDP dotazy reagovat.

3. Datové body pro rodiny střídačů ET a EH

Střídače řad ET a EH disponují nejširší nativní podporou senzorů. Tyto entity poskytují data přímo v energetických jednotkách (kWh), což je ideální pro dlouhodobé statistiky a Energy Dashboard.

Entita (Datový bod)	Význam pro energetický management
Meter Total Energy (export)	Celková energie dodaná do distribuční sítě.
Meter Total Energy (import)	Celková energie odebraná z distribuční sítě.
Total PV Generation	Celková produkce fotovoltaického systému.
Total Battery Charge	Celková energie uložená do baterií.
Total Battery Discharge	Celková energie odebraná z baterií.

4. Postup pro výpočet energetických bilancí

U modelů, které neposkytují kumulativní hodnoty (kWh) přímo, je nutné provést matematickou transformaci z okamžitého výkonu měřeného ve Wattech (W).

Technický postup:

1. Separace hodnot (Template Sensor): Vytvořte šablonu senzoru pro rozdělení okamžitého výkonu na samostatné entity pro nákup (buy power) a prodej (sell power).
2. Integrace v čase (Riemann Sum): Pro převod okamžitého výkonu (W) na kumulativní energii (kWh) aplikujte integraci Riemann Sum.
  * Doporučení: Pro výpočty ve fotovoltaice použijte metodu "Left Riemann Sum" (method: left). Tato metoda vykazuje vyšší přesnost při zpracování náhlých změn (špiček) v produkci nebo spotřebě, které jsou pro solární systémy typické.

5. Frekvence dotazování (Polling Interval) a stabilita

Standardní interval dotazování je nastaven na 10 sekund.

Stabilita a cloud SEMS:

Ve vzácných případech může časté lokální dotazování způsobit kolizi s odesíláním dat na cloudový portál Goodwe SEMS. Pokud zaznamenáte výpadky dat v cloudu, snižte frekvenci lokálního dotazování na 30 sekund až 1 minutu.

Nastavení vlastního intervalu v Home Assistant:

Pro definování vlastního intervalu postupujte následovně:

1. Přejděte do Nastavení > Zařízení a služby > [Integrace GoodWe].
2. Klikněte na ikonu tří teček (Menu) u dané instance a zvolte Systémové volby.
3. Deaktivujte volbu "Povolit dotazování na aktualizace".
4. Vytvořte novou automatizaci (Nastavení > Automatizace a scény):
  * Spouštěč: Časový vzor (např. /30 pro každých 30 sekund).
  * Akce: Vyberte Provést akci a zvolte homeassistant.update_entity.
  * Cíl: Vyberte entity střídače GoodWe, které chcete aktualizovat.

6. Diagnostika a řešení potíží

Při instalaci nebo údržbě postupujte podle tohoto kontrolního seznamu:

* Síťová vrstva: Ověřte, zda je střídač na stejné podsíti jako řídicí systém a zda není UDP port 8899 blokován firewallem.
* Verifikace ARM: Pokud střídač neodpovídá, je prioritou č. 1 ověření a případný upgrade ARM firmwaru ze strany podpory GoodWe.
* Mobilní aplikace: Pokud data nelze vyčíst ani v PvMaster/SolarGo, problém spočívá v síťové kartě střídače nebo jeho vnitřním nastavení.
* Konzistence cloudu: Pokud po aktivaci integrace začne vynechávat cloud SEMS, upravte interval dotazování dle postupu v sekci 5.
* Jednotky: Pro správné zobrazení v energetických grafech se ujistěte, že výsledné senzory z Riemannova součtu jsou konfigurovány na jednotky kWh.
