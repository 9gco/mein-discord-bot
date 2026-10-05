# Deployment auf den gratis Pterodactyl-Hostern

Für Monkey Network, ElysianNodes, HeavenCloud, VexaNode, Waifly, Darkless, Kerit,
VisiHost und NexCloud. Alle ohne Kreditkarte, alle Pterodactyl.

Diese Anleitung ist die Alternative zu `deploy/setup-vm.sh`, das eine echte VM
mit root und systemd voraussetzt. Im Panel gibt es beides nicht.

## Kein Push-Deploy über die API – aber der Bot aktualisiert sich selbst

Die Client-API von Monkey Network ist laut ihrer OpenAPI-Spezifikation
(`https://monkey-network.xyz/openapi.json`) eine Teilmenge des Pterodactyl-Apis
mit genau drei lesenden Endpoints: Serverliste, Serverdetails, Ressourcen.
Es gibt kein `power` und kein `files/write`. Damit kann GitHub Actions nichts
hochladen und nichts neustarten.

Stattdessen aktualisiert sich der Bot selbst. Aktivieren im Panel unter
**Startup → Environment**:

```
AUTO_UPDATE=true
AUTO_UPDATE_INTERVAL_MIN=10
```

Zusätzlich im Panel: die **Node.js-Egg muss `git` enthalten**. Die meisten
Pterodactyl-NodeJS-Eggs haben es.

So läuft es:

1. Der Bot fragt alle zehn Minuten per `git ls-remote` die Revision von `main`
   im öffentlichen Repository ab. Kein Token, kein SSH-Key.
2. Bei Änderung klont er den Stand in ein Staging-Verzeichnis, macht dort
   `npm ci` und `npm run build`.
3. **Erst wenn der Build erfolgreich war**, wird `dist/` getauscht. Ein
   kaputter Push lässt den laufenden Bot unangetastet weiterlaufen.
4. Der Bot beendet sich mit Exit-Code 1. Pterodactyl startet bei einem
   Absturz automatisch neu, und der neue Code läuft.

Der erste Start schreibt nur die aktuelle Revision fest und löst kein Update
aus – sonst würde jeder frische Deploy sofort nachlegen.

Zwei Dinge, die man wissen sollte:

- `.github/workflows/ci.yml` läuft auf GitHub-gehosteten Runnern. Für ein
  öffentliches Repository ist das kostenlos, und es prüft Typecheck, Tests und
  Build bei jedem Push. Das ist das Tor, damit der Bot nie einen roten Commit
  einspielt.
- `git` und `npm` müssen im Container vorhanden sein, und das Staging-Verzeichnis
  braucht temporär rund 200 MB Platz. Bei 2 GB Disk kein Problem.

## Renewal: alle 14 Tage bestätigen

Monkey Network wirbt auf der Startseite mit "free forever", im FAQ steht aber:
jeder Server muss **alle 14 Tage** über das Lifecycle-System bestätigt werden.
Wird das verpasst, gilt der Server als inaktiv und kann zurückgefordert werden.
Die Startseite verschweigt das, deshalb hier ausdrücklich.

"HeavenCloud bestätigt nach 7 Tagen", Monkey Network nach 14. Wer das
vergisst, verliert die Konfiguration und muss den Bot neu hochladen.

Frei ist Monkey Network außerdem nur "für die Lebensdauer von MonkeyBytes
Hosting selbst" - ein Nicht-Profit-Projekt, kein Unternehmen mit Vertrag.

## RAM: 512 MB reichen

Auf diesem Rechner gemessen, nicht geschätzt:

| Komponente | Peak |
| --- | --- |
| Node mit `discord.js` geladen | 87 MB |
| `opusscript` Opus-Decoder | +1 MB |
| `ffmpeg` als Kindprozess (MP3 aus TTS) | 10 MB |
| Disk: `node_modules` + `dist` + Daten | ~170 MB |

Der Bot liegt damit im Betrieb bei rund 150–250 MB. 512-MB-Container passen,
256-MB-Container sind grenzwertig. `start.sh` liest das Limit des Containers
und begrenzt den Node-Heap auf 60 % davon, damit der OOM-Killer nicht zuschlägt.

## 1. Release erzeugen

```powershell
powershell -ExecutionPolicy Bypass -File deploy\pterodactyl\release.ps1
```

Das Skript baut `dist/` und legt auf dem Desktop ein `mdb-release.zip` ab mit
`dist/`, `package.json`, `package-lock.json` und `deploy/pterodactyl/start.sh`.

`node_modules` gehört nicht ins Archiv, und `dist/` auch nicht ungeprüft: der
Container baut nichts nach, weil `ffmpeg-static` sein Binary erst beim
`npm ci` passend zur Plattform lädt. Ein hochgeladenes `node_modules` von
Windows enthält nur `ffmpeg.exe` und der Bot crasht bei der ersten
Sprachausgabe mit ENOENT.

Zwei Details, an denen das Skript absichtlich nicht spart: es schreibt die
Eintragsnamen mit `/` statt mit `\`, weil Windows-ZIPs unter Linux sonst
Dateien namens `dist\index.js` erzeugen, und es konvertiert `start.sh` nach LF,
weil mit CRLF die Shebang nicht läuft.

Falls das Panel kein ZIP entpacken kann: lokal entpacken und den Ordner per
SFTP hochladen.

## 2. Container einrichten

Auf **Monkey Network** lässt sich der Startup-Befehl *nicht* ändern. Das Egg
führt immer genau diese Schritte aus:

```
if [[ -d .git ]] && [[ AUTO_UPDATE == 1 ]]; then git pull; fi
if [[ -n $NODE_PACKAGES ]]; then npm install $NODE_PACKAGES; fi
if [ -f /home/container/package.json ]; then npm install --production; fi
node /home/container/<Hauptdatei>
```

Deshalb läuft der Bot über `main.js` im Repository-Root statt über
`dist/index.js`. `dist/` ist in `.gitignore`, fehlt also nach jedem `git pull`;
`main.js` baut es bei Bedarf und startet den Bot danach. Als Bash-Skript wäre das
nicht möglich, weil das Egg die Hauptdatei mit `node` startet.

| Angabe im Panel | Wert |
| --- | --- |
| Egg | NodeJS (die Version mit dem neuesten `node` aus `node -v`) |
| Docker-Image | Nodejs 25 |
| Git-Repository-Adresse | `https://github.com/9gco/mein-discord-bot.git` |
| Install Branch | `main` |
| Automatische Aktualisierung | `1` |
| Hauptdatei | `main.js` |
| Vom Benutzer hochgeladene Dateien | `0` (Installation nicht überspringen) |

Danach die Installation auslösen, damit das Egg das Repository klont. Ab dem
zweiten Start ist `dist/` vorhanden und der Build entfällt.

**Wichtig:** Das Egg installiert vorher mit `npm install --production`, also ohne
Dev-Dependencies. TypeScript fehlt dann. `main.js` installiert es deshalb vor dem
Build nach.

Kein ZIP und kein SFTP-Upload nötig. Der Release-Weg aus Schritt 1 bleibt als
Alternative für Hoster, deren Startup-Befehl man ändern kann.

## 3. Umgebungsvariablen

Im Panel unter **Startup → Environment** eintragen:

```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
PERSISTENT_DATA_DIR=/home/container/data
LOG_LEVEL=info
AUTO_UPDATE=true
```

`PERSISTENT_DATA_DIR` zeigt bewusst in den Container. Alles andere dort
(Verify-Konfiguration, gespeicherte Tickets) überlebt Neustarts, wird aber bei
einem Neuinstallieren des Servers gelöscht. Für die große Konfiguration im
Studio reicht das; wenn du Sicherung brauchst, `deploy/backup.sh` schreiben
oder die Dateien gelegentlich per SFTP rauskopieren.

`PORT` wird nicht gebraucht, der Bot startet keinen Webserver.

## 4. Aktualisieren

Mit `AUTO_UPDATE=true` erledigt sich das von selbst, siehe oben. Ohne den
Schalter bleiben vier Handgriffe pro Update:

1. `release.ps1` laufen lassen (siehe 1.)
2. Panel auf **Maintenance Mode**
3. `mdb-release.zip` per SFTP nach `/home/container/` hochladen und entpacken,
   dabei `node_modules/` und `data/` nicht überschreiben
4. Server neu starten
5. Maintenance Mode wieder aus

`start.sh` vergleicht die Prüfsumme von `package-lock.json` und installiert nur
bei Änderung neu. Danach startet der Bot in wenigen Sekunden.

## Grenzen dieser Hoster

- Kein systemd, kein `git pull`. Deshalb dieses Skript statt `deploy/deploy.sh`.
- `node dist/index.js` läuft im Vordergrund, damit das Panel den Prozess sieht.
  Bricht der Bot ab, startet ihn das Panel neu, aber es gibt kein
  `Restart=always` mit Backoff wie auf der VM.
- Der Hostler kann die Free-Tier-Regeln jederzeit ändern. HeavenCloud sperrt
  Container ohne Klick-Renew alle 7 Tage und löscht sie nach 2 Tagen, Waifly
  suspendiert nach 3 Tagen Offline. Bei Monkey Network steht keine
  Renewal-Pflicht in den Bedingungen, eine Anti-Abuse-Klausel aber schon.
- Zwei Instanzen mit demselben Token melden sich beide bei Discord an und
  reagieren auf dasselbe Kommando. Vor dem Start hier den Railway-Service
  stoppen.