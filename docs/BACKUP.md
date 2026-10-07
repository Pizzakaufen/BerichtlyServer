# Backup und Wiederherstellung

Alle Daten von Berichtly Server liegen in PostgreSQL. Der Server selbst ist zustandslos (Programm, Nginx-Konfiguration und
Konfigurationsdatei lassen sich jederzeit neu installieren). Gesichert werden müssen also:

1. die **Datenbank** (regelmäßig) und
2. die **Konfiguration** `/etc/berichtly-server/berichtly-server.env` bzw. `.env` (einmalig und nach Änderungen;
   enthält Secrets – getrennt und verschlüsselt aufbewahren).

Berichtly Server 1.2 enthält bewusst **keine eingebaute automatische Backup-Funktion**: Ein Backup, das auf
demselben Server oder im selben Container liegt, schützt nicht vor Plattenausfall, Fehlbedienung oder
Kompromittierung. Zuverlässig ist ein Ablauf, der die Sicherung **außerhalb** des Servers ablegt – dafür sind die
Standardwerkzeuge von PostgreSQL gedacht.

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
