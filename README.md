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

Der Worker lässt nur Requests an `adsb.lol`, `adsb.fi` und `airframes.io` durch
(kein offener Relay), reicht einen mitgeschickten Airframes-Key durch und
kostet im Cloudflare-Free-Tier nichts (100.000 Requests/Tag).

## CORS-Umweg (Fallback ohne eigenen Proxy)

`adsb.lol`, `adsb.fi` und `airframes.io` sind primär für Server-zu-Server-Aufrufe
gebaut und senden nicht immer CORS-Header für beliebige Browser-Origins. Die
App versucht deshalb erst den direkten Request, und weicht bei einem
Fehlschlag automatisch auf einen öffentlichen CORS-Proxy aus (`corsproxy.io`,
danach `api.allorigins.win`), siehe `fetchJson()` in `app.js`.

Das ist ein Workaround, kein Endzustand: öffentliche Proxys sind selbst
rate-limitiert und nicht 100 % verfügbar. Für Dauerbetrieb lohnt sich später
ein eigener, minimaler Proxy (z. B. ein kostenloser Cloudflare-Worker, der die
drei APIs server-seitig abruft und mit eigenen CORS-Headern zurückgibt) —
dann fällt die Abhängigkeit von Drittanbieter-Proxys weg.

## Datenquellen

| Daten     | Quelle                                    | Key nötig? |
|-----------|--------------------------------------------|------------|
| Position  | [adsb.lol](https://api.adsb.lol/docs)      | Nein       |
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
