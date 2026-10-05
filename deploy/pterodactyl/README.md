# Deployment auf den gratis Pterodactyl-Hostern

Für Monkey Network, ElysianNodes, HeavenCloud, VexaNode, Waifly, Darkless, Kerit,
VisiHost und NexCloud. Alle ohne Kreditkarte, alle Pterodactyl.

Diese Anleitung ist die Alternative zu `deploy/setup-vm.sh`, das eine echte VM
mit root und systemd voraussetzt. Im Panel gibt es beides nicht.

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

node_modules und .git gehören nicht ins Archiv. `git archive` nimmt nur
versionierte Dateien mit und lässt lokale Installationen automatisch weg:

```powershell
git archive --format=zip --output="$env:USERPROFILE\Desktop\mdb-release.zip" main
```

Das Archiv enthält `dist/` **nicht**, weil `dist/` in `.gitignore` steht. Das ist
richtig so: der Build läuft im Container, weil `ffmpeg-static` sein Binary erst
beim `npm ci` passend zur Plattform lädt. Ein hochgeladenes `node_modules` von
Windows enthält nur `ffmpeg.exe` und der Bot crasht bei der ersten Sprachausgabe.

Falls das Panel kein ZIP entpacken kann: lokal entpacken und den Ordner per
SFTP hochladen (FileZilla, Port aus dem Panel übernehmen).

## 2. Container einrichten

| Angabe | Wert |
| --- | --- |
| Egg | NodeJS (die Version mit dem neuesten `node` aus `node -v`) |
| Startup | `bash /home/container/deploy/pterodactyl/start.sh` |
| Install-Command | leer lassen, `start.sh` holt die Dependencies selbst |

Der erste Start installiert rund 165 MB Dependencies, dauert also ein bis drei
Minuten, bis im Console Log `Bot startet` erscheint.

## 3. Umgebungsvariablen

Im Panel unter **Startup → Environment** eintragen:

```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
PERSISTENT_DATA_DIR=/home/container/data
LOG_LEVEL=info
```

`PERSISTENT_DATA_DIR` zeigt bewusst in den Container. Alles andere dort
(Verify-Konfiguration, gespeicherte Tickets) überlebt Neustarts, wird aber bei
einem Neuinstallieren des Servers gelöscht. Für die große Konfiguration im
Studio reicht das; wenn du Sicherung brauchst, `deploy/backup.sh` schreiben
oder die Dateien gelegentlich per SFTP rauskopieren.

`PORT` wird nicht gebraucht, der Bot startet keinen Webserver.

## 4. Aktualisieren

Nach einem Push auf GitHub:

1. Release neu erzeugen (`git archive`, siehe 1.)
2. Archiv in den Container hochladen und entpacken, dabei `data/` und
   `node_modules/` **nicht** überschreiben
3. Server im Panel neu starten

`start.sh` vergleicht die Prüfsumme von `package-lock.json` und installiert nur
bei Änderung neu. Sonst startet der Bot in wenigen Sekunden.

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