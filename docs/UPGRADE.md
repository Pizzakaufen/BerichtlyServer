# Upgrade von Berichtly Server 1.0 Alpha auf 1.1

Berichtly Server 1.1 ist eine kompatible Weiterentwicklung von 1.0 Alpha. Alle Benutzer, Profile, Geräte,
Sitzungen und Berichte bleiben erhalten; angemeldete Apps müssen sich nicht neu anmelden.

## Was beim Upgrade passiert

- Die Migration `0002_server_1_1.sql` wird angewendet. Sie ist **rein additiv**: neue Spalten (mit
  Standardwerten bzw. `NULL`), neue Tabellen (`sync_operations`, `security_events`, `server_state`) und neue
  Indizes. Es wird keine Zeile gelöscht oder verändert.
- Bestehende Geräte erhalten den Synchronisationsstatus `NEVER`, bis sie zum ersten Mal einen Abschluss melden.
  Die bisherigen Werte `lastPullAt`/`lastPullCursor`/`lastPushAt` bleiben erhalten.
- Bestehende Berichte haben keine Herkunftsangaben (`clientUpdatedAt`, `clientLocalId` … = `null`).
- Der Upgrade-Weg ist automatisiert getestet (`TestUpgradeVon10AlphaAuf11OhneDatenverlust`): 1.0-Schema mit
  realistischen Daten anlegen, migrieren, Prüfsumme aller Bestandsdaten vergleichen, danach Login, Abfragen,
  Synchronisierung und Bearbeitung über die API.

## Ablauf (systemd)

```bash
# 1. Backup (siehe docs/BACKUP.md)
sudo -u postgres pg_dump -Fc berichtly > berichtly-vor-1.1-$(date +%F).dump

# 2. Release-Archiv 1.1 entpacken und installieren (Konfiguration bleibt unverändert)
tar xzf berichtly-server-1.1.0-linux-amd64.tar.gz
cd berichtly-server-1.1.0-linux-amd64
sudo ./deploy/install.sh        # führt bei laufendem Dienst Migrationen aus und startet neu

# 3. Prüfen
CONF=/etc/berichtly-server/berichtly-server.env
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF migrate-status
sudo -u berichtly /opt/berichtly-server/berichtly-server --env-file $CONF db-check
curl -s http://127.0.0.1:8080/api/v1/health/ready
```

Die neue systemd-Unit wird von `install.sh` ebenfalls installiert. Neue Konfigurationsoptionen (siehe unten)
haben sichere Standardwerte und müssen nicht gesetzt werden.

## Ablauf (Docker Compose)

```bash
docker compose exec -T db pg_dump -U berichtly -Fc berichtly > berichtly-vor-1.1-$(date +%F).dump
git pull                        # bzw. neuen Projektstand einspielen
docker compose up -d --build    # Server migriert beim Start (DB_MIGRATE_ON_START=true)
docker compose ps
```

## Sicherheitsnetz beim Start

1.1 startet nicht, wenn das Datenbankschema älter ist als erwartet und `DB_MIGRATE_ON_START=false` gesetzt ist –
statt mit einem unvollständigen Schema Fehler zu produzieren. Migrationen, die nach dem Anwenden verändert wurden,
werden per Prüfsumme erkannt und blockieren den Start (`migrate-status` zeigt `modified`).

## Rückweg

Ein Downgrade auf 1.0 ist mit dem 1.1-Schema technisch möglich (1.0 ignoriert die neuen Spalten und Tabellen),
wird aber nicht getestet und nicht empfohlen. Sicherer Weg: das vor dem Upgrade erstellte Backup
wiederherstellen (docs/BACKUP.md).

## Änderungen an der API (alle rückwärtskompatibel)

Bestehende Endpunkte, Felder und Fehlercodes aus 1.0 sind unverändert. Neu:

| Bereich | Neu in 1.1 |
|---|---|
| System | `GET /health/ready` (Readiness: Datenbank + Schema) |
| Auth/Konto | `POST /auth/logout-all`, `POST /account/password`, `GET /account/security-events`, `GET /sessions`, `DELETE /sessions/{id}` |
| Geräte | `POST /devices`, `GET /devices/{id}`, `PATCH /devices/{id}`; `GET /devices` ist paginiert (`meta`) und kennt `includeRevoked`; `DELETE /devices/{id}` markiert das Gerät zusätzlich als abgemeldet |
| Berichte | Optionale Felder `clientUpdatedAt`, `clientLocalId` in Anfragen; Antworten zusätzlich mit `clientUpdatedAt`, `clientLocalId`, `createdByDeviceId`, `lastModifiedByDeviceId`, `lastOperationId`; Listenfilter `year`, `month`, `isoYear`, `isoWeek` |
| Wochen | `GET /weeks/{isoYear}/{isoWeek}`; Wochenübersicht zusätzlich mit `today` |
| Sync | `POST /sync` (Push + Pull in einem Schritt), `POST /sync/complete`; Push-Elemente mit optionaler `operationId`; Ergebnisse mit `operationId`, `replayed`; `GET /sync/status` zusätzlich mit `minValidCursor` und Gerätestatus (`syncStatus`, `lastSyncAt` …) |
| Fehlercodes | `SYNC_CURSOR_EXPIRED` (410), `DEVICE_REQUIRED` (409), `OPERATION_ID_REUSED` (im Push-Ergebnis) |

Hinweis zu `GET /devices`: Abgemeldete Geräte erscheinen standardmäßig nicht mehr in der Liste (in 1.0 gab es
noch kein Abmelden auf Geräteebene, nur das Widerrufen der Sitzungen).

## Neue Konfigurationsoptionen

| Variable | Standard | Bedeutung |
|---|---|---|
| `RATE_LIMIT_LOGIN_PER_MINUTE` | 10 | Login pro IP |
| `RATE_LIMIT_LOGIN_PER_ACCOUNT_PER_MINUTE` | 5 | Login pro Konto (E-Mail) |
| `RATE_LIMIT_REGISTER_PER_MINUTE` | 5 | Registrierung pro IP |
| `RATE_LIMIT_REFRESH_PER_MINUTE` | 30 | Token-Erneuerung pro IP |
| `TOMBSTONE_RETENTION_DAYS` | 365 | Aufbewahrung gelöschter Berichte für die Synchronisierung |
| `SYNC_OPERATION_RETENTION_DAYS` | 30 | Aufbewahrung der Idempotenz-Einträge |
| `SECURITY_EVENT_RETENTION_DAYS` | 180 | Aufbewahrung der Sicherheitsereignisse |
| `SESSION_RETENTION_DAYS` | 30 | Löschen abgelaufener/widerrufener Sitzungen |
| `MAINTENANCE_INTERVAL_HOURS` | 24 | Automatische Wartung (0 = aus) |

`RATE_LIMIT_AUTH_PER_MINUTE` aus 1.0 wird weiterhin berücksichtigt: Ist die Variable gesetzt, gilt ihr Wert als
Standard für Login, Registrierung und Token-Erneuerung – das Verhalten einer bestehenden Installation ändert sich
also nicht, bis die neuen Variablen gesetzt werden.
