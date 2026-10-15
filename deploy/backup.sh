#!/usr/bin/env bash
# Berichtly Server 2.0 – Datenbank-Backup mit Integritätsprüfung und Protokoll.
#
# Ablauf:
#   1. pg_dump im Format "custom" in eine temporäre Datei (erst nach erfolgreicher Prüfung umbenannt),
#   2. Prüfung: pg_restore --list muss das gesamte Archiv lesen können (Inhaltsverzeichnis ≥ 1 Tabelle),
#   3. SHA-256-Prüfsumme als <datei>.sha256 daneben,
#   4. Aufbewahrung: ältere Backups als RETENTION_DAYS werden gelöscht – nie das gerade erstellte,
#   5. Ergebnis (Erfolg oder Fehler) wird über "berichtly-server backup-record" protokolliert und erscheint im
#      Admin-Dashboard unter „System“.
#
# Grenzen der Prüfung: pg_restore --list beweist, dass das Archiv vollständig lesbar und strukturell intakt ist.
# Ob eine Wiederherstellung inhaltlich gelingt, zeigt nur eine Probe-Wiederherstellung (siehe docs/BACKUP.md).
# Ein Backup auf demselben Server schützt nicht vor Plattenausfall – Dateien zusätzlich extern abholen lassen.
#
# Verwendung:
#   systemd/Linux:  sudo deploy/backup.sh [--env-file /etc/berichtly-server/berichtly-server.env]
#   Docker Compose: deploy/backup.sh --docker     (im Verzeichnis mit docker-compose.yml)
# Umgebungsvariablen: BACKUP_DIR (Standard /var/backups/berichtly), RETENTION_DAYS (Standard 14),
#                     DB_NAME/DB_USER (Standard berichtly).

set -euo pipefail
umask 077

MODE=systemd
ENV_FILE=/etc/berichtly-server/berichtly-server.env
while [[ $# -gt 0 ]]; do
    case "$1" in
        --docker) MODE=docker; shift ;;
        --env-file) ENV_FILE="$2"; shift 2 ;;
        -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
        *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    esac
done

BACKUP_DIR="${BACKUP_DIR:-/var/backups/berichtly}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DB_NAME="${DB_NAME:-berichtly}"
DB_USER="${DB_USER:-berichtly}"
[[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] || { echo "RETENTION_DAYS muss eine Zahl sein" >&2; exit 2; }

STARTED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NAME="berichtly-$(date -u +%Y%m%d-%H%M%S).dump"
TARGET="$BACKUP_DIR/$NAME"
TMP="$TARGET.partial"

record() { # result size sha verified verification error
    local args=(backup-record --file "$NAME" --started "$STARTED" --result "$1")
    [[ -n "$2" ]] && args+=(--size "$2")
    [[ -n "$3" ]] && args+=(--sha256 "$3")
    args+=(--verified "$4")
    [[ -n "$5" ]] && args+=(--verification "$5")
    [[ -n "$6" ]] && args+=(--error "$6")
    if [[ "$MODE" == docker ]]; then
        docker compose run --rm -T server "${args[@]}" >/dev/null || echo "Warnung: Ergebnis konnte nicht protokolliert werden" >&2
    else
        sudo -u berichtly berichtly-server --env-file "$ENV_FILE" "${args[@]}" >/dev/null || echo "Warnung: Ergebnis konnte nicht protokolliert werden" >&2
    fi
}

fail() {
    rm -f "$TMP"
    echo "Backup FEHLGESCHLAGEN: $1" >&2
    record FAILED "" "" false "" "$1"
    exit 1
}

install -d -m 0700 "$BACKUP_DIR" || fail "Verzeichnis $BACKUP_DIR nicht anlegbar"

# 1. Dump
if [[ "$MODE" == docker ]]; then
    docker compose exec -T db pg_dump -U "$DB_USER" --format=custom "$DB_NAME" > "$TMP" || fail "pg_dump fehlgeschlagen"
else
    sudo -u postgres pg_dump --format=custom "$DB_NAME" > "$TMP" || fail "pg_dump fehlgeschlagen"
fi
SIZE="$(stat -c %s "$TMP")"
[[ "$SIZE" -gt 0 ]] || fail "Backup-Datei ist leer"

# 2. Integritätsprüfung (Archiv vollständig lesbar, enthält Tabellen)
if [[ "$MODE" == docker ]]; then
    LIST="$(docker compose exec -T db pg_restore --list < "$TMP" 2>&1)" || fail "pg_restore --list konnte das Archiv nicht lesen"
else
    LIST="$(pg_restore --list "$TMP" 2>&1)" || fail "pg_restore --list konnte das Archiv nicht lesen"
fi
TABLES="$(grep -c ' TABLE DATA ' <<<"$LIST" || true)"
[[ "$TABLES" -ge 1 ]] || fail "Archiv enthält keine Tabellendaten"
grep -q 'TABLE DATA public users' <<<"$LIST" || fail "Tabelle users fehlt im Archiv"

# 3. Prüfsumme, dann atomar umbenennen
SHA="$(sha256sum "$TMP" | cut -d' ' -f1)"
mv "$TMP" "$TARGET"
echo "$SHA  $NAME" > "$TARGET.sha256"

# 4. Aufbewahrung (nie die soeben erstellte Datei)
find "$BACKUP_DIR" -maxdepth 1 -name 'berichtly-*.dump' -mtime +"$RETENTION_DAYS" ! -name "$NAME" -print -delete | sed 's/^/Gelöscht (Aufbewahrung): /'
find "$BACKUP_DIR" -maxdepth 1 -name 'berichtly-*.dump.sha256' -mtime +"$RETENTION_DAYS" ! -name "$NAME.sha256" -delete

record SUCCESS "$SIZE" "$SHA" true "pg_restore --list: $TABLES Tabellen lesbar" ""
echo "Backup erstellt und geprüft: $TARGET ($SIZE Byte, $TABLES Tabellen, SHA-256 $SHA)"
