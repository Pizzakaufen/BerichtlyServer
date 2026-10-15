#!/usr/bin/env bash
# Berichtly Server 2.0 – Wiederherstellung eines Backups von deploy/backup.sh.
#
# Ersetzt den GESAMTEN Datenbankinhalt durch den Stand des Backups. Ablauf:
#   1. Prüfsumme gegen <datei>.sha256 prüfen (falls vorhanden) und Archiv mit pg_restore --list lesen,
#   2. ausdrückliche Bestätigung (Eingabe des Datenbanknamens),
#   3. Server stoppen, Datenbank neu anlegen, Backup einspielen,
#   4. Migrationen ausführen (Backups älterer Versionen) und Sync-Cursor zurücksetzen,
#   5. Server starten und Bereitschaft prüfen.
#
# Verwendung:
#   systemd/Linux:  sudo deploy/restore.sh <backup.dump> [--env-file /etc/berichtly-server/berichtly-server.env]
#   Docker Compose: deploy/restore.sh <backup.dump> --docker
# Probe-Wiederherstellung ohne den Live-Betrieb zu berühren: siehe docs/BACKUP.md („Probe-Wiederherstellung“).

set -euo pipefail

FILE="${1:-}"
[[ -n "$FILE" && -f "$FILE" ]] || { echo "Verwendung: $0 <backup.dump> [--docker] [--env-file <pfad>]" >&2; exit 2; }
shift
MODE=systemd
ENV_FILE=/etc/berichtly-server/berichtly-server.env
while [[ $# -gt 0 ]]; do
    case "$1" in
        --docker) MODE=docker; shift ;;
        --env-file) ENV_FILE="$2"; shift 2 ;;
        *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    esac
done
DB_NAME="${DB_NAME:-berichtly}"
DB_USER="${DB_USER:-berichtly}"

# 1. Prüfen
if [[ -f "$FILE.sha256" ]]; then
    EXPECTED="$(cut -d' ' -f1 < "$FILE.sha256")"
    ACTUAL="$(sha256sum "$FILE" | cut -d' ' -f1)"
    [[ "$EXPECTED" == "$ACTUAL" ]] || { echo "Prüfsumme stimmt NICHT – Datei beschädigt oder verändert. Abbruch." >&2; exit 1; }
    echo "Prüfsumme in Ordnung."
else
    echo "Hinweis: keine .sha256-Datei gefunden – Prüfsumme wird nicht kontrolliert."
fi
if [[ "$MODE" == docker ]]; then
    docker compose exec -T db pg_restore --list < "$FILE" > /dev/null || { echo "Archiv nicht lesbar. Abbruch." >&2; exit 1; }
else
    pg_restore --list "$FILE" > /dev/null || { echo "Archiv nicht lesbar. Abbruch." >&2; exit 1; }
fi
echo "Archiv lesbar."

# 2. Bestätigung
echo
echo "ACHTUNG: Der gesamte Inhalt der Datenbank '$DB_NAME' wird durch das Backup ersetzt."
echo "Änderungen nach dem Zeitpunkt des Backups gehen auf dem Server verloren (Geräte laden ihre neueren"
echo "Änderungen nach dem Zurücksetzen der Sync-Cursor erneut hoch, sofern sie dort noch vorhanden sind)."
read -r -p "Zum Fortfahren den Datenbanknamen eingeben ($DB_NAME): " ANSWER
[[ "$ANSWER" == "$DB_NAME" ]] || { echo "Abgebrochen."; exit 1; }

# 3.–5. Einspielen
if [[ "$MODE" == docker ]]; then
    docker compose stop server
    docker compose exec -T db dropdb -U "$DB_USER" --if-exists "$DB_NAME"
    docker compose exec -T db createdb -U "$DB_USER" "$DB_NAME"
    docker compose exec -T db pg_restore -U "$DB_USER" --dbname="$DB_NAME" --no-owner < "$FILE"
    docker compose run --rm server migrate
    docker compose run --rm server reset-sync-cursors
    docker compose up -d server
    sleep 5
    docker compose exec -T server node src/cli.ts healthcheck && echo "Server bereit."
else
    systemctl stop berichtly-server
    sudo -u postgres dropdb --if-exists "$DB_NAME"
    sudo -u postgres createdb --owner="$DB_USER" "$DB_NAME"
    sudo -u postgres pg_restore --dbname="$DB_NAME" --no-owner --role="$DB_USER" "$FILE"
    sudo -u berichtly berichtly-server --env-file "$ENV_FILE" migrate
    sudo -u berichtly berichtly-server --env-file "$ENV_FILE" reset-sync-cursors
    systemctl start berichtly-server
    sleep 3
    sudo -u berichtly berichtly-server --env-file "$ENV_FILE" healthcheck && echo "Server bereit."
fi
