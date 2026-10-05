# Erzeugt das Upload-Archiv fuer die gratis Pterodactyl-Hoster (Windows).
#
#   powershell -ExecutionPolicy Bypass -File deploy\pterodactyl\release.ps1
#
# Ergebnis: eine ZIP mit dist/, package.json, package-lock.json und start.sh.
# Die ZIP per SFTP nach /home/container/ hochladen und entpacken, dann im
# Panel neu starten. node_modules und der Datenordner bleiben unangetastet -
# beides steht bewusst nicht im Archiv.

[CmdletBinding()]
param(
    [string]$OutputPath = "$env:USERPROFILE\Desktop\mdb-release.zip"
)

$ErrorActionPreference = 'Stop'

# deploy\pterodactyl -> deploy -> Repo-Wurzel
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root

Write-Host '==> Abhaengigkeiten pruefen'
if (-not (Test-Path 'node_modules')) {
    npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci fehlgeschlagen' }
} else {
    Write-Host '    node_modules vorhanden, uebersprungen'
}

Write-Host '==> Build'
npm run build
if ($LASTEXITCODE -ne 0) { throw 'npm run build fehlgeschlagen' }

Write-Host '==> Release-Ordner vorbereiten'
$stage = Join-Path $env:TEMP 'mdb-release'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Copy-Item 'dist' -Destination $stage -Recurse
Copy-Item 'package.json', 'package-lock.json' -Destination $stage

$shTarget = Join-Path $stage 'deploy\pterodactyl'
New-Item -ItemType Directory -Path $shTarget -Force | Out-Null

# .gitattributes erzwingt LF fuer *.sh, aber die ZIP entsteht ausserhalb von
# Git. Deshalb hier noch einmal explizit umstellen - mit CRLF bricht die
# Shebang und start.sh laeuft nicht.
$sh = Get-Content 'deploy\pterodactyl\start.sh' -Raw
$sh = $sh -replace "`r`n", "`n"
[System.IO.File]::WriteAllText(
    (Join-Path $shTarget 'start.sh'),
    $sh,
    (New-Object System.Text.UTF8Encoding $false)
)

Write-Host '==> ZIP schreiben'
if (Test-Path $OutputPath) { Remove-Item $OutputPath -Force }

# Compress-Archive ist hier unbrauchbar: es schreibt Windows-Dateinamen mit
# Backslash in die ZIP-Eintragsnamen. Linux entpackt daraus Dateien wie
# "dist\index.js" statt eines Verzeichnisses. Deshalb das Archiv von Hand
# bauen und jeden Pfad mit Slash eintragen.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$archive = [System.IO.Compression.ZipFile]::Open($OutputPath, 'Create')
try {
    Get-ChildItem -Path $stage -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($stage.Length + 1) -replace '\\', '/'
        $entry = $archive.CreateEntry(
            $relative,
            [System.IO.Compression.CompressionLevel]::Optimal
        )
        $entry.LastWriteTime = $_.LastWriteTime
        $in = [System.IO.File]::OpenRead($_.FullName)
        $out = $entry.Open()
        try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }
    }
} finally {
    $archive.Dispose()
}

$size = [Math]::Round((Get-Item $OutputPath).Length / 1MB, 1)

Write-Host ''
Write-Host "Fertig: $OutputPath ($size MB)"
Write-Host ''
Write-Host 'Naechste Schritte:'
Write-Host '  1. Panel auf Maintenance Mode stellen'
Write-Host '  2. ZIP per SFTP nach /home/container/ hochladen und entpacken'
Write-Host '     (node_modules/ und data/ nicht ueberschreiben)'
Write-Host '  3. Im Panel neu starten'
Write-Host '  4. Maintenance Mode wieder ausschalten'
Write-Host ''
Write-Host 'Der erste Start installiert ~165 MB Dependencies: 1-3 Minuten.'
Write-Host 'Danach erscheint im Console-Log "Bot startet".'