# Architektur – Berichtly Server 1.1

## Schichten

```
HTTP (net/http, Go-Standardbibliothek)
 └─ Middleware: Request-ID · Logging · Panic-Recovery · Security-Header · CORS · Rate Limiting · Auth
     └─ httpapi   – Routen/Handler: Parameter lesen, Antworten formen, Fehler übersetzen
         └─ service  – Geschäftslogik, Transaktionen, Zugriffsschutz, Konfliktregeln
             └─ store    – SQL mit Platzhaltern, Mapping auf Domänentypen, Migrationen
                 └─ PostgreSQL (Constraints, Trigger, Indizes)
```

- Handler kennen kein SQL, das `store`-Paket kennt kein HTTP.
- Jede schreibende Service-Operation ist genau eine Datenbanktransaktion.
- Abhängigkeiten werden in `internal/app` per Konstruktor verdrahtet – kein Framework, keine Reflection-Magie.

## Projektstruktur

```
cmd/berichtly-server/      Kommandozeile (serve, migrate, migrate-status, db-check, check-config, healthcheck,
                           maintenance, reset-sync-cursors, seed-dev, version)
api/                       OpenAPI-Spezifikation (in die Binärdatei eingebettet)
internal/
  app/                     Verdrahtung, Logger, automatische Wartung, Entwicklungs-Seed
  config/                  Konfiguration aus Umgebungsvariablen und .env-Dateien
  httpapi/                 routesV1 (alle /api/v1-Routen), Middleware, Handler, Health/Status, API-Doku,
                           Integrations-, Szenario-, Upgrade- und Leistungstests
  service/                 Auth, Konto, Profil, Berichte, Wochen, Synchronisierung, Geräte
  store/                   Datenbankzugriff, Migrationen (migrations/*.sql), Wartung, Idempotenz-Speicher
  model/                   Domänentypen (Datum, ISO-Woche, Berichte, Profil …) und JSON-Darstellung
  security/                Argon2id, JWT, Refresh Tokens
  validate/                Feldgenaue Eingabevalidierung
  apperr/                  Fehlertypen mit stabilen Fehlercodes
deploy/                    systemd-Unit, Installationsskript, Nginx/Caddy-Vorlagen
scripts/build-release.sh   Linux-Release-Archive (amd64/arm64)
```

## Datenmodell

| Tabelle | Inhalt | Wichtige Eigenschaften |
|---|---|---|
| `users` | Konto | UUID-Schlüssel (nicht die E-Mail), E-Mail eindeutig und normalisiert, Argon2id-Hash, Zeitzone, Sperrstatus |
| `user_profiles` | Profil | 1:1 zum Konto, `version`, `change_seq` |
| `devices` | Geräte | Geräte-ID des Clients eindeutig **pro Konto**, letzter Pull/Push |
| `sessions` | Sitzungen | pro Login, optional an ein Gerät gebunden, widerrufbar, absolute Höchstdauer |
| `refresh_tokens` | Refresh Tokens | nur SHA-256-Hash, einmal verwendbar, Ablaufzeit |
| `daily_reports` | Tagesberichte | UUID, Datum, Text, Notiz, Reihenfolge, Status, `version`, `change_seq`, `deleted_at` |
| `weekly_reports` | Wochenberichte | Wochenstart = Montag (DB-Check), max. ein aktiver Bericht je Woche (partieller Unique-Index) |
| `sync_operations` | Verarbeitete Sync-Operationen | Idempotenz: Ergebnis je `operationId` (ohne Inhalte), Aufbewahrung 30 Tage |
| `security_events` | Sicherheitsereignisse | Typ, Zeit, technische IDs – keine Inhalte, E-Mails oder IPs |
| `server_state` | Serverzustand | Cursor-Epoche und Untergrenze gültiger Sync-Cursor |
| `schema_migrations` | Migrationsstand | Version, Name, Prüfsumme |

Alle persönlichen Daten hängen per Fremdschlüssel (`ON DELETE CASCADE`) an genau einem Konto.

**Indizes** für häufige Abfragen: `(user_id, report_date)` für aktive Berichte, `(user_id, change_seq)` für die
Synchronisierung, `(user_id, updated_at)`, `(user_id, week_start)`, Hash-Index der Refresh Tokens. Listen sind
paginiert, die Synchronisierung arbeitet mit Cursor – auch viele tausend Berichte werden nie auf einmal geladen.

**Zeit**: Zeitpunkte sind `TIMESTAMPTZ`, gesetzt von der Datenbank (`now()`), also eine einzige Uhr unabhängig von der
Zeitzone des Servers. Kalenderdaten (`DATE`) sind reine Daten ohne Uhrzeit; "heute" wird immer in der Zeitzone
des Kontos berechnet (Standard `Europe/Berlin`). Die Zeitzonendaten sind in die Binärdatei eingebettet.

## Erweiterbarkeit

- **API-Versionen**: Alle Routen liegen unter `/api/v1`. Eine v2 wird als zusätzlicher Routenbaum ergänzt;
  Services und Store werden geteilt, v1 bleibt, solange App-Versionen sie nutzen.
- **Neue synchronisierbare Datentypen** (z. B. Berichtsversionen, Einstellungen): Tabelle mit `version`,
  `change_seq`, `deleted_at` und Trigger `berichtly_touch_syncable` anlegen, `service.VersionedStore`
  implementieren, in `service.Sync` (Pull und Push) ergänzen.
- **Geräte und Sitzungen** sind getrennt modelliert – Push-Tokens oder "alle Geräte abmelden" lassen sich ohne
  Umbau ergänzen.
- **Monitoring**: Request- und Fehlerzähler stehen im internen Status; ein Prometheus-Endpunkt kann darauf aufbauen.
- **Mehrere Instanzen**: Rate Limiting ist prozesslokal. Für mehrere Instanzen wäre ein gemeinsamer
  Speicher nötig – für einen einzelnen VPS nicht erforderlich.

## Ressourcenverbrauch

Ein Prozess, keine Hintergrund-Jobs, keine externen Dienste. Datenbank-Pool standardmäßig max. 10 Verbindungen,
höchstens 4 gleichzeitige Argon2-Berechnungen (je 19 MiB). Läuft auf einem kleinen VPS mit 512 MB–1 GB RAM neben
PostgreSQL.
