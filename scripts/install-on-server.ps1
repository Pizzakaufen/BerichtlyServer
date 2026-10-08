# Berichtly Server – Installation auf einem Linux-Server direkt von Windows aus (ein Befehl).
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-on-server.ps1 -Server 203.0.113.10 -Domain berichtly.example.de -Email admin@example.de
#
# Kopiert das Release-Paket aus dist\ per SSH auf den Server und führt dort deploy/setup.sh aus. Benötigt nur den
# in Windows enthaltenen OpenSSH-Client (ssh/scp). Beim ersten Verbinden fragt SSH nach Bestätigung und Passwort
# des Servers – beides wird nur von SSH verarbeitet, nicht von diesem Skript.
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][string]$Email,
    [string]$User = 'root'
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$version = (Get-Content (Join-Path $root 'VERSION') -Raw).Trim()
$package = Join-Path $root "dist\berichtly-server-$version.tar.gz"
if (-not (Test-Path $package)) {
    throw "Paket nicht gefunden: $package. Zuerst bauen: sh scripts/build-release.sh (Git Bash)."
}
if ($Domain -notmatch '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$') {
    throw "Ungültige Domain: $Domain"
}
if ($Email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw "Ungültige E-Mail-Adresse: $Email" }

$target = "$User@$Server"
Write-Host "==> Kopiere berichtly-server-$version.tar.gz nach $target ..."
scp $package "${target}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw 'Kopieren fehlgeschlagen (Server-Adresse, Benutzer und SSH-Zugang prüfen).' }

$sudo = if ($User -eq 'root') { '' } else { 'sudo ' }
$remote = "set -e; mkdir -p ~/berichtly-install && tar -xzf /tmp/berichtly-server-$version.tar.gz -C ~/berichtly-install && " +
          "${sudo}sh ~/berichtly-install/berichtly-server-$version/deploy/setup.sh '$Domain' '$Email'"
Write-Host "==> Starte die Einrichtung auf dem Server ..."
ssh -t $target $remote
if ($LASTEXITCODE -ne 0) { throw "Einrichtung fehlgeschlagen (Meldung oben). Der Befehl kann gefahrlos wiederholt werden." }
Write-Host "`nFertig: https://$Domain/api/v1/health"
