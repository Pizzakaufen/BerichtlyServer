# Architektur – Berichtly Server 1.2

## Laufzeit

```
Nginx (öffentlich: TLS, HSTS, Body-Limit, Grund-Rate-Limit, Request-ID, JSON-Zugriffslog)
 └─ Node.js 24 LTS, ein Prozess (127.0.0.1:3000)
     └─ Fastify 5: Hooks für Request-ID · Security-Header · CORS · Rate Limiting · Auth · Logging · Fehlerformat
         └─ http/      – Routen (routes-v1.ts), Parameter lesen, Antworten formen
             └─ services/  – Geschäftslogik, Transaktionen, Zugriffsschutz, Konfliktregeln, Synchronisierung
                 └─ db/        – SQL mit Platzhaltern ($1 …), Mapping auf Domänentypen, Migrationen, Wartung
                     └─ PostgreSQL (Constraints, Trigger, Indizes)
```

- Handler kennen kein SQL, die Repositories kennen kein HTTP.
- Jede schreibende Service-Operation ist genau eine Datenbanktransaktion; Abrufe, die mehrere Tabellen
  zusammenführen (Sync-Pull, Wochenübersicht), laufen in einem Snapshot (`REPEATABLE READ READ ONLY`).
- Abhängigkeiten werden in `src/app.ts` per Konstruktor verdrahtet – kein Dependency-Injection-Framework.
- Node.js führt den TypeScript-Quellcode direkt aus (Type Stripping, nur "erasable" TypeScript). `tsc --noEmit`
  prüft die Typen in Entwicklung und Tests; es gibt keinen Build-Schritt und kein generiertes JavaScript.

## Projektstruktur

```
src/
  cli.ts                   Kommandozeile (serve, migrate, migrate-status, db-check, check-config, healthcheck,
                           maintenance, reset-sync-cursors, seed-dev, version), kontrollierter Shutdown
  app.ts                   Verdrahtung, automatische Wartung, Entwicklungs-Seed, Version (aus package.json)
  config/config.ts         Konfiguration aus Umgebungsvariablen und .env-Dateien (gleiche Variablen wie 1.1)
  http/
    server.ts              Fastify-Instanz, Hooks, Fehler-/404-/405-Behandlung, Health, interner Status, Doku
    routes-v1.ts           alle /api/v1-Routen
    respond.ts             Antworthüllen, JSON-Body, Query-/Pfadparameter
    limiter.ts             Token-Bucket-Rate-Limiter, Metriken
  services/                Auth, Konto/Profil/Geräte, Berichte/Wochen, Synchronisierung, Versionierte Schreibregeln
  db/
    pool.ts                Connection-Pool (pg), Transaktionen, Snapshot, Benutzersperre
    migrate.ts             Migrationen mit Prüfsummen und Advisory Lock
    migrations/*.sql       0001 (1.0), 0002 (1.1), 0003 (1.2)
    repositories/          Benutzer, Sitzungen/Geräte/Ereignisse, Profile/Berichte, Idempotenz/Cursor/Wartung
  domain/                  Fehlercodes, Datum/ISO-Woche/Zeitzone, Modelle und JSON-Darstellung
  security/                Argon2id (node:crypto), JWT (HS256), Refresh Tokens
  validation/              Feldgenaue Eingabevalidierung
bin/berichtly-server       Startskript (node src/cli.ts)
api/openapi.yaml           OpenAPI-Spezifikation
deploy/                    systemd-Unit, Installationsskripte, Nginx-Vorlagen und -Snippets
test/                      unit/, integration/ (gegen PostgreSQL), nginx/ (Full-Stack), perf/
```

## Abhängigkeiten

| Paket | Zweck |
|---|---|
| `fastify` | HTTP-Server, Routing, Body-Limit, Proxy-Vertrauen, kontrolliertes Schließen |
| `pg` | PostgreSQL-Treiber mit Connection-Pool (ausschließlich parametrisierte Abfragen) |

Alles andere stammt aus der Node.js-Standardbibliothek (`node:crypto` für Argon2id, HMAC, Zufall; `node:test` für
Tests). Entwicklungsabhängigkeiten: `typescript` (nur Typprüfung), `@types/*`, `yaml` (OpenAPI-Test). Versionen
sind in `package-lock.json` festgeschrieben; installiert wird mit `npm ci --ignore-scripts`.

## Datenmodell

| Tabelle | Inhalt | Wichtige Eigenschaften |
|---|---|---|
| `users` | Konto | UUID-Schlüssel (nicht die E-Mail), E-Mail eindeutig und normalisiert, Argon2id-Hash, Zeitzone, Sperrstatus |
| `user_profiles` | Profil | 1:1 zum Konto, `version`, `change_seq` |
| `devices` | Geräte | Geräte-ID des Clients eindeutig **pro Konto**, letzter Pull/Push, Synchronisationsstatus |
| `sessions` | Sitzungen | pro Login, optional an ein Gerät gebunden, widerrufbar, absolute Höchstdauer |
| `refresh_tokens` | Refresh Tokens | nur SHA-256-Hash, einmal verwendbar, Ablaufzeit |
| `daily_reports` | Tagesberichte | UUID, Datum, Text, Notiz, Reihenfolge, Status, `version`, `change_seq`, `deleted_at` |
| `weekly_reports` | Wochenberichte | Wochenstart = Montag (DB-Check), max. ein aktiver Bericht je Woche (partieller Unique-Index) |
| `sync_operations` | Verarbeitete Sync-Operationen | Idempotenz: Ergebnis je `operationId` (ohne Inhalte), `hash_format` (1 = 1.1, 2 = 1.2), Aufbewahrung 30 Tage |
| `security_events` | Sicherheitsereignisse | Typ, Zeit, technische IDs – keine Inhalte, E-Mails oder IPs |
| `server_state` | Serverzustand | Cursor-Epoche und Untergrenze gültiger Sync-Cursor |
| `schema_migrations` | Migrationsstand | Version, Name, Prüfsumme |

Alle persönlichen Daten hängen per Fremdschlüssel (`ON DELETE CASCADE`) an genau einem Konto.

**Indizes** für häufige Abfragen: `(user_id, report_date)` für aktive Berichte, `(user_id, change_seq)` für die
Synchronisierung, `(user_id, week_start)`, `(user_id, sync_status)` für Geräte, Hash-Index der Refresh Tokens.
Listen sind paginiert, die Synchronisierung arbeitet mit Cursor – auch viele tausend Berichte werden nie auf einmal
geladen (Leistungstest mit 300 000 Berichten).

**Zeit**: Zeitpunkte sind `TIMESTAMPTZ`, gesetzt von der Datenbank (`now()`); jede Datenbankverbindung arbeitet in
UTC. Kalenderdaten (`DATE`) werden als `YYYY-MM-DD`-Strings ohne Zeitzonenumrechnung gelesen. "Heute" wird immer in
der Zeitzone des Kontos berechnet (Standard `Europe/Berlin`, über die ICU-Zeitzonendaten von Node.js).

## Kontrollierter Shutdown

SIGTERM/SIGINT → neue Anfragen erhalten `503 SERVICE_UNAVAILABLE` mit `Connection: close` → laufende Anfragen
werden beendet, freie Keep-Alive-Verbindungen geschlossen → Wartungs-Timer gestoppt → Datenbank-Pool geschlossen.
Nach `SHUTDOWN_TIMEOUT_SECONDS` werden verbliebene Verbindungen hart getrennt. Getestet in `system.test.ts`.

## Erweiterbarkeit

- **API-Versionen**: Alle Routen liegen unter `/api/v1` (`routes-v1.ts`). Eine v2 erhält eine eigene Datei
  `routes-v2.ts` unter `/api/v2`; Services und Datenbank werden geteilt, v1 bleibt, solange App-Versionen sie nutzen.
- **Neue synchronisierbare Datentypen**: Tabelle mit `version`, `change_seq`, `deleted_at` und Trigger
  `berichtly_touch_syncable` anlegen, `VersionedStore` implementieren, in `SyncService` (Pull und Push) ergänzen.
- **Monitoring**: Request- und Fehlerzähler stehen im internen Status; ein Prometheus-Endpunkt kann darauf aufbauen.
- **Mehrere Instanzen**: Das Rate Limiting in Node.js ist prozesslokal (Nginx begrenzt zusätzlich). Für mehrere
  Instanzen wäre ein gemeinsamer Speicher nötig – für einen einzelnen VPS nicht erforderlich.

## Ressourcenverbrauch

Ein Node.js-Prozess, keine externen Dienste außer PostgreSQL. Datenbank-Pool standardmäßig max. 10 Verbindungen,
höchstens 4 gleichzeitige Argon2-Berechnungen (je 19 MiB). Nginx benötigt nur wenige MB. Läuft auf einem kleinen
VPS mit 1 GB RAM neben PostgreSQL.
