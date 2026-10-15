# Backup und Wiederherstellung

Alle Daten von Berichtly Server liegen in PostgreSQL. Der Server selbst ist zustandslos (Programm, Nginx-Konfiguration und
Konfigurationsdatei lassen sich jederzeit neu installieren). Gesichert werden müssen also:

1. die **Datenbank** (regelmäßig) und
2. die **Konfiguration** `/etc/berichtly-server/berichtly-server.env` bzw. `.env` (einmalig und nach Änderungen;
   enthält Secrets – getrennt und verschlüsselt aufbewahren) und
3. beim Betrieb ohne Domain den **TLS-Schlüssel** `/etc/berichtly-server/tls/` (einmalig; ohne ihn ändert sich nach
   einer Neuinstallation der Fingerabdruck und alle Apps müssten neu verbunden werden).

Ein Backup, das auf demselben Server oder im selben Container liegt, schützt nicht vor Plattenausfall,
Fehlbedienung oder Kompromittierung. Zuverlässig ist ein Ablauf, der die Sicherung zusätzlich **außerhalb** des
Servers ablegt.

## Backup-Skript (seit 2.0)

`deploy/backup.sh` erstellt ein Dump, **prüft** es und protokolliert das Ergebnis (sichtbar im Admin-Dashboard unter
„System“ und mit `berichtly-server backups`):

1. `pg_dump --format=custom` in eine temporäre Datei,
2. Integritätsprüfung: `pg_restore --list` muss das gesamte Archiv lesen können und Tabellendaten (mindestens
   `users`) finden – erst dann wird die Datei umbenannt,
3. SHA-256-Prüfsumme als `<datei>.sha256`,
4. Aufbewahrung: ältere Dateien als `RETENTION_DAYS` (Standard 14) werden gelöscht, nie die gerade erstellte,
5. Protokoll über `berichtly-server backup-record` – auch Fehlschläge.

```bash
sudo deploy/backup.sh                                   # systemd-Installation
sudo BACKUP_DIR=/srv/backup RETENTION_DAYS=30 deploy/backup.sh
deploy/backup.sh --docker                               # Docker Compose (im Projektverzeichnis)
```

**Grenzen der Prüfung:** Ein Backup gilt nicht schon als erfolgreich, weil eine Datei entstanden ist. Das Skript
beweist, dass das Archiv vollständig lesbar und strukturell intakt ist und die Kerntabelle enthält. Ob eine
Wiederherstellung inhaltlich vollständig gelingt, zeigt nur eine **Probe-Wiederherstellung** (unten) – regelmäßig,
mindestens nach jedem Upgrade.

Täglich per systemd-Timer (Beispiel, als root anlegen):

```ini
# /etc/systemd/system/berichtly-backup.service
[Unit]
Description=Berichtly Server – Datenbank-Backup
After=postgresql.service

[Service]
Type=oneshot
Environment=BACKUP_DIR=/var/backups/berichtly RETENTION_DAYS=14
ExecStart=/opt/berichtly-server/deploy/backup.sh

# /etc/systemd/system/berichtly-backup.timer
[Unit]
Description=Berichtly Server – tägliches Backup

[Timer]
OnCalendar=*-*-* 03:15
Persistent=true

[Install]
WantedBy=timers.target
```

`systemctl daemon-reload && systemctl enable --now berichtly-backup.timer`. Den Pfad zum Skript an die eigene
Installation anpassen. Die Dateien anschließend von einem **anderen** Rechner abholen (Pull-Prinzip, z. B.
`rsync`, `restic` oder `borg`).

## Probe-Wiederherstellung (ohne den Live-Betrieb zu berühren)

```bash
sudo -u postgres createdb berichtly_restore_test
sudo -u postgres pg_restore --dbname=berichtly_restore_test --no-owner /var/backups/berichtly/berichtly-….dump
sudo -u postgres psql berichtly_restore_test -c "SELECT count(*) FROM users; SELECT count(*) FROM daily_reports; SELECT max(version) FROM schema_migrations;"
sudo -u postgres dropdb berichtly_restore_test
```

Die Zahlen mit dem Admin-Dashboard („Übersicht“) vergleichen.

## Wiederherstellung per Skript (seit 2.0)

`deploy/restore.sh <datei.dump> [--docker]` prüft Prüfsumme und Lesbarkeit, verlangt die Eingabe des
Datenbanknamens als Bestätigung, stoppt den Server, spielt das Backup ein, führt Migrationen aus, setzt die
Sync-Cursor zurück (siehe unten) und startet den Server wieder. Die manuellen Schritte stehen weiter unten.

> **Teststand:** `backup.sh` und `restore.sh` wurden geschrieben und mit `bash -n` auf Syntax geprüft, aber in der
> Entwicklungsumgebung **nicht ausgeführt** (kein PostgreSQL verfügbar). Vor dem ersten Einsatz einmal mit einer
> Probe-Wiederherstellung kontrollieren.

## Manuelles Backup

```bash
# systemd-Installation (PostgreSQL auf demselben Server)
sudo -u postgres pg_dump --format=custom --file=berichtly-$(date +%F).dump berichtly

# Docker Compose
docker compose exec -T db pg_dump -U berichtly --format=custom berichtly > berichtly-$(date +%F).dump
```

Das Format `custom` ist komprimiert und erlaubt eine selektive Wiederherstellung. Das Backup enthält
personenbezogene Daten (Berichte, Profile): verschlüsselt übertragen und aufbewahren, z. B.

```bash
gpg --symmetric --cipher-algo AES256 berichtly-2026-10-04.dump     # erzeugt berichtly-2026-10-04.dump.gpg
```

## Automatisierung (Vorschlag)

Ein täglicher Cronjob oder systemd-Timer auf dem Server erstellt das Dump; ein **anderer** Rechner holt es ab
(Pull-Prinzip, z. B. per `rsync` oder `restic`/`borg` auf ein externes Ziel). So hat ein kompromittierter Server
keinen Schreibzugriff auf die älteren Sicherungen.

```bash
# /etc/cron.d/berichtly-backup – Dump um 03:15 Uhr, 14 Tage lokal vorhalten
15 3 * * * postgres pg_dump --format=custom --file=/var/backups/berichtly/berichtly-$(date +\%F).dump berichtly && find /var/backups/berichtly -name '*.dump' -mtime +14 -delete
```

(`/var/backups/berichtly` vorher mit `install -d -o postgres -g postgres -m 0700 /var/backups/berichtly` anlegen.)

Diese Vorlage ist nicht Teil des Servers und wurde nicht automatisiert getestet – nach dem Einrichten unbedingt
eine Wiederherstellung ausprobieren.

## Wiederherstellung

```bash
# 1. Dienst stoppen
sudo systemctl stop berichtly-server              # bzw. docker compose stop server

# 2. Datenbank leeren und Backup einspielen
sudo -u postgres dropdb berichtly
sudo -u postgres createdb --owner=berichtly berichtly
sudo -u postgres pg_restore --dbname=berichtly --no-owner --role=berichtly berichtly-2026-10-04.dump

# Docker Compose
docker compose exec -T db dropdb -U berichtly berichtly
docker compose exec -T db createdb -U berichtly berichtly
docker compose exec -T db pg_restore -U berichtly --dbname=berichtly --no-owner < berichtly-2026-10-04.dump

# 3. Schema prüfen (bei Backup einer älteren Version werden fehlende Migrationen ergänzt)
CONF=/etc/berichtly-server/berichtly-server.env
sudo -u berichtly berichtly-server --env-file $CONF migrate

# 4. WICHTIG: Sync-Cursor zurücksetzen (siehe unten), dann starten
sudo -u berichtly berichtly-server --env-file $CONF reset-sync-cursors
sudo systemctl start berichtly-server
# Docker Compose: docker compose run --rm server reset-sync-cursors && docker compose up -d
```

## Warum `reset-sync-cursors` nach einer Wiederherstellung nötig ist

Ein Backup enthält auch den Zähler der Änderungsnummern. Nach dem Einspielen springt er auf den Stand des Backups
zurück. Geräte, die nach dem Backup noch synchronisiert haben, besitzen dann einen Cursor, der *größer* ist als
die neuen Änderungsnummern – sie würden neue Änderungen übersehen.

`reset-sync-cursors` setzt den Zähler weit nach vorne und erklärt alle bisher ausgestellten Cursor für ungültig.
Jedes Gerät erhält beim nächsten Abruf `410 SYNC_CURSOR_EXPIRED`, synchronisiert vollständig neu (`cursor=0`) und
lädt dabei seine lokal neueren Änderungen wieder hoch. Da Berichts-IDs stabil sind, entstehen keine Duplikate.
Dieser Ablauf ist automatisiert getestet (`test/integration/sync-scenarios.test.ts`, "Cursor zurücksetzen nach Wiederherstellung").
