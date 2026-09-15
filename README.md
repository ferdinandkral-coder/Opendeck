# OpenDeck

Freier, quelloffener Live-Flugverfolger als installierbare PWA. Zeigt
ADS-B-Positionen auf einer Karte und — sobald ein eigener Key hinterlegt ist —
ACARS-Cockpit-Nachrichten aus dem Airframes.io-Netzwerk.

Kein eigener Server nötig, kein Build-Schritt: reines HTML/CSS/JS, läuft
direkt über GitHub Pages.

## Kartenkacheln

Nutzt die Standard-OpenStreetMap-Tiles (`tile.openstreetmap.org`), per
CSS-Filter (`invert` + `hue-rotate`) auf das dunkle EFIS-Look gebracht — kein
Kartenaccount, kein Key. Carto hatte ihre bisher genutzten `dark_nolabels`-Tiles
zwischenzeitlich hinter einen Pflicht-Key gesetzt, daher der Wechsel.

Für ernsthafteren Dauerbetrieb lohnt trotzdem ein Blick auf die
[OSM-Tile-Nutzungsrichtlinien](https://operations.osmfoundation.org/policies/tiles/) —
bei sehr vielen Nutzern/Requests empfiehlt sich ein eigener kostenloser Key bei
z. B. [MapTiler](https://www.maptiler.com/) oder [Stadia Maps](https://stadiamaps.com/).

## ACARS: gruppiert & übersetzt

Nachrichten werden nach Flugzeug gruppiert (eine Karte pro Aircraft, neueste
zuerst) statt als endlose chronologische Liste. Antippen einer Karte klappt
ältere Nachrichten desselben Flugzeugs auf. Bekannte Label-Codes (`H1`,
OOOI-Codes `80`–`83`, …) werden in Klartext übersetzt — das ist **Best-Effort**,
viele ARINC-620-Labels sind Airline-/Avionik-spezifisch und nicht abgedeckt;
unbekannte Codes zeigen einfach den Rohcode. Liste in `ACARS_LABELS` in
`app.js`, bei Bedarf erweiterbar.

## Drei ADS-B-Quellen, nacheinander

`adsb.lol` und `adsb.fi` scheinen Cloud-IP-Bereiche (auch Cloudflare Workers)
strenger zu limitieren/blocken als Heimnetz-IPs — im Debug-Log äußert sich
das als 429/403 über den eigenen Proxy. Deshalb als dritte, unabhängige
Quelle [OpenSky Network](https://openskynetwork.github.io/opensky-api/rest.html)
ergänzt — ein akademisches Projekt der TU München, explizit für genau solche
Hobby-Auswertungen gedacht, mit Bounding-Box-Abfrage statt Punkt+Radius (passt
noch direkter zum "nach Kartenausschnitt laden"-Ansatz). Anonym ohne Key
nutzbar, aber mit niedrigem Tageskontingent (~400 Requests/Tag) — sollte bei
den aktuellen Poll-Intervallen reichen, aber nicht großzügig sein.

Alle drei blockten in Tests konsequent Cloudflares IP-Bereich (429/403/Timeout)
— ein kostenloses OpenSky-Konto (⚙ → "OpenSky-Konto") identifiziert Anfragen
über Login statt nur IP und hebt das Tageskontingent deutlich an; ob es den
IP-Block umgeht, ist nicht garantiert, aber der naheliegendste nächste
Versuch.

## Flugzeug-Icons & Marker-Stabilität

Icons unterscheiden sich jetzt nach Typ (Heavy/Regional/GA/Helikopter, Rest
als Standard-Schmalrumpf-Silhouette) und Airline (Farbe aus einem Hash des
3-Buchstaben-Rufzeichen-Präfix — keine echten Airline-Farben/Logos, nur pro
Airline konsistent). Mapping in `TYPE_CATEGORY`/`airlineColor()` in `app.js`,
bei Bedarf erweiterbar.

Marker wurden vorher sofort entfernt, wenn ein Flugzeug in der aktuellen
Poll-Antwort fehlte — das flackerte stark, weil `adsb.lol` und `adsb.fi`
unterschiedliche Feeder-Abdeckung haben und bei jedem Quellenwechsel
unterschiedliche Flugzeuglisten liefern. Jetzt zeitbasiert: ein Marker
verschwindet erst, wenn er 45 Sekunden lang von **keiner** Quelle gemeldet
wurde.

## Kartenausschnitt statt fixem Radius

Flugzeuge werden nach dem sichtbaren Kartenausschnitt geladen, nicht nach
einem festen Radius ab einem fixen Punkt: rein-/rauszoomen oder verschieben
löst automatisch (debounced) einen neuen Request mit passendem Radius aus.
Der "Max. Suchradius" in ⚙ ist nur noch eine Obergrenze dafür.

Ein echter 3D-Globus (WebGL/Three.js, wie in der Random-Route-App) wäre der
nächste sinnvolle Schritt, ist aber ein eigenes, größeres Vorhaben — löst die
CORS-/Rate-Limit-Themen der Datenquellen nicht, ändert nur die Darstellung.
Aktuell erstmal bewusst zurückgestellt, bis die Datenschicht stabil läuft.

## Eigener Proxy (empfohlen)

Öffentliche CORS-Proxys sind ein Notbehelf — sie blocken irgendwann mit
401/429, weil sie selbst überlastet oder limitiert sind. Zuverlässiger: ein
eigener, kostenloser Proxy auf Cloudflare Workers (kein CLI, keine
Kreditkarte nötig):

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages**
   → **Create** → **Worker**, einen Namen vergeben (z. B. `opendeck-proxy`),
   einmal auf **Deploy** klicken zum Anlegen.
2. **Edit code** öffnen, kompletten Inhalt löschen, den Code aus
   [`cloudflare-worker.js`](cloudflare-worker.js) hier im Repo einfügen,
   erneut **Deploy**.
3. Die URL kopieren (`https://opendeck-proxy.<du>.workers.dev`).
4. In OpenDeck unter ⚙ **Eigener Proxy** einfügen, Speichern.

Der Worker lässt nur Requests an `adsb.lol`, `adsb.fi`, `airframes.io` und
`opensky-network.org` durch (kein offener Relay), reicht einen mitgeschickten
Auth-Header (Airframes-Key oder OpenSky-Token) durch und kostet im
Cloudflare-Free-Tier nichts (100.000 Requests/Tag).

## Zweiter Proxy: Deno Deploy

`adsb.lol`, `adsb.fi` und besonders `opensky-network.org` (deren Doku das
explizit erwähnt) blocken oder limitieren Cloudflares IP-Bereich strenger als
z. B. eine normale Mobilfunk-Verbindung. Ein zweiter Proxy auf anderer
Infrastruktur ist da manchmal der einzige Ausweg:

1. [dash.deno.com](https://dash.deno.com) → **New Project** → **Playground**
2. Platzhalter-Code löschen, den Inhalt aus
   [`deno-proxy.js`](deno-proxy.js) hier im Repo einfügen
3. Speichern (deployt meist automatisch)
4. Die URL kopieren (`https://<projekt>.deno.dev`)
5. In OpenDeck unter ⚙ **Zweiter Proxy** einfügen, Speichern

Beide Proxys können parallel eingetragen sein — pro Quelle merkt sich die App
(`stickyWrapper` in `app.js`), welcher Weg zuletzt funktioniert hat, und
probiert den zuerst.

## CORS-Umweg (Fallback ohne eigenen Proxy)

`adsb.lol`, `adsb.fi` und `airframes.io` sind primär für Server-zu-Server-Aufrufe
gebaut und senden nicht immer CORS-Header für beliebige Browser-Origins. Die
App versucht deshalb erst den direkten Request, und weicht bei einem
Fehlschlag automatisch auf `corsproxy.io` als schnell scheiternden Notnagel
aus, siehe `fetchJson()` in `app.js`. `allorigins.win` wurde nach Auswertung
des Debug-Logs entfernt — hing dort bei jedem Versuch die vollen 7 Sekunden
fest, statt schnell zu scheitern oder zu funktionieren.

Das ist ein Workaround, kein Endzustand: öffentliche Proxys sind selbst
rate-limitiert und nicht 100 % verfügbar. Für Dauerbetrieb lohnt sich später
ein eigener, minimaler Proxy (z. B. ein kostenloser Cloudflare-Worker, der die
drei APIs server-seitig abruft und mit eigenen CORS-Headern zurückgibt) —
dann fällt die Abhängigkeit von Drittanbieter-Proxys weg.

## Datenquellen

| Daten     | Quelle                                    | Key nötig? |
|-----------|--------------------------------------------|------------|
| Position  | [adsb.lol](https://api.adsb.lol/docs) → [adsb.fi](https://adsb.fi) → [OpenSky Network](https://openskynetwork.github.io/opensky-api/rest.html) | Nein       |
| ACARS     | [airframes.io](https://docs.airframes.io/api/) | Nein — Key optional, hebt nur das Rate-Limit an |

Airframes.io lässt öffentliche Endpunkte auch anonym zu, nur mit niedrigerem
Rate-Limit. OpenDeck läuft also von Anfang an mit beiden Datenquellen ohne
jeden Key — bei zu vielen Requests kommt im ACARS-Fach ein Hinweis auf das
Limit, kein Absturz.

### Airframes-Key holen (optional, für höheres Limit)

1. Eigenen VHF-ACARS- oder VDL2-Feed einrichten (z. B. `acarsdec` /
   `dumpvdl2` auf einem Raspberry Pi mit RTL-SDR-Dongle) und an
   airframes.io senden.
2. Auf [docs.airframes.io/api/authentication](https://docs.airframes.io/api/authentication)
   den kostenlosen Feeder-Key anfordern.
3. In der App unter ⚙ Einstellungen eintragen.

Die ACARS-Abfrage in `app.js` (`pollAcars`) zielt auf `/v1/messages` mit
`lat`/`lon`/`radius` — die Airframes-API entwickelt sich weiter, das
[OpenAPI-Schema](https://docs.airframes.io/assets/files/openapi-7fdd396265cda28d187596f3444af9e5.yaml)
lohnt sich als Referenz, falls sich Parameter geändert haben.

## Lokal testen

Kein Build nötig, aber `fetch()` und der Service Worker brauchen einen
echten HTTP-Kontext (kein `file://`):

```bash
cd opendeck
python3 -m http.server 8000
# dann http://localhost:8000 öffnen
```

## Auf GitHub Pages deployen

1. Neues Repo auf GitHub anlegen, diesen Ordnerinhalt pushen:
   ```bash
   git init
   git add .
   git commit -m "OpenDeck: initial version"
   git branch -M main
   git remote add origin https://github.com/<dein-user>/opendeck.git
   git push -u origin main
   ```
2. Im Repo unter **Settings → Pages** als Quelle den `main`-Branch
   (Ordner `/`) wählen.
3. Nach ein bis zwei Minuten ist die App unter
   `https://<dein-user>.github.io/opendeck/` erreichbar.
4. Auf dem Android-Handy die Seite öffnen → Browsermenü →
   **Zum Startbildschirm hinzufügen**. Läuft danach wie eine native App
   (eigenes Icon, kein Adressbalken, Grundgerüst offline-fähig).

## Bekannte Grenzen / mögliche Erweiterungen

- **Wichtig bei jeder Änderung an `index.html`, `style.css`, `app.js`,
  `manifest.json` oder `icon.svg`:** die Version in `sw.js`
  (`const CACHE = "opendeck-shell-vX"`) hochzählen. Sonst hält der Browser
  die alte, gecachte Version für unverändert und liefert sie ewig weiter,
  egal was auf GitHub Pages liegt.
- Reichweite ist an das aktuelle Kartenzentrum gekoppelt (`radiusNm`,
  Standard 100 NM) — bei Bedarf in den Einstellungen anpassen.
- Historische Flüge/Routen (`/airframes/flights/{id}/route` bei
  Airframes) sind noch nicht angebunden.
- Flugzeug-Icons sind generisch; Typ-spezifische Silhouetten wären ein
  guter nächster Schritt.
- Kein Push für Notfallmeldungen — aktuell reines Poll-Intervall
  (8 s ADS-B / 15 s ACARS).

## Lizenz

MIT — nutz es, ändere es, mach draus was du willst. Achte bei den
Datenquellen selbst auf deren jeweilige Nutzungsbedingungen
([adsb.lol Terms](https://api.adsb.lol/docs), [Airframes Licensing](https://docs.airframes.io/api/licensing)).
