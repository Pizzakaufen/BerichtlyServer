# API und geplante Anbindung der Android-App (Berichtly 2.2)

Vollständige Referenz: [`api/openapi.yaml`](../api/openapi.yaml), im Entwicklungsmodus auch als Swagger UI unter
`/api/docs`. Die Spezifikation eignet sich zur Generierung eines Kotlin-Clients (z. B. OpenAPI Generator); ein
Test stellt sicher, dass jede Route des Servers darin dokumentiert ist.

## Versionierung

Alle Endpunkte liegen unter **`/api/v1`** und werden im Code in einer eigenen Datei (`src/http/routes-v1.ts`)
registriert. Innerhalb von v1 gibt es nur abwärtskompatible Änderungen (neue Endpunkte, neue optionale Felder) –
so auch in 1.1; 1.2 (Node.js) lässt v1 unverändert (Liste der Ergänzungen: [UPGRADE.md](UPGRADE.md)). Inkompatible
Änderungen erscheinen unter `/api/v2` (eigene Datei `routes-v2.ts`), während v1 für bestehende App-Versionen
weiterläuft. Der Server ignoriert unbekannte Felder in
Anfragen; die App sollte unbekannte Felder in Antworten ebenfalls ignorieren (`ignoreUnknownKeys = true`).

## Basis-URL und Transport

Die App spricht ausschließlich `https://<domain>/api/v1/...` an (Nginx, TLS 1.2/1.3). HTTP wird mit `308` auf HTTPS
umgeleitet, die App sollte aber nie HTTP verwenden (Android blockiert Klartext ohnehin standardmäßig). Bei
`503 SERVICE_UNAVAILABLE` (Neustart, Update, Datenbank nicht erreichbar) später erneut versuchen und `Retry-After`
beachten; Sync-Operationen mit `operationId` dürfen gefahrlos wiederholt werden. Eine eigene `X-Request-ID` der App
(8–64 Zeichen `[A-Za-z0-9_-]`) wird von Nginx und Server übernommen und erleichtert die Fehlersuche.

## Antwortformat

```json
{ "data": { } }
{ "data": [ ], "meta": { "page": 1, "limit": 50, "total": 132, "hasMore": true } }
```

Fehler:

```json
{ "error": {
    "code": "VALIDATION_FAILED",
    "message": "Die Eingabedaten sind ungültig.",
    "requestId": "6f0c…",
    "details": [ { "field": "text", "issue": "too_long:max=5000" } ],
    "conflict": null } }
```

`code` ist stabil und maschinenlesbar, `message` für Menschen. Stacktraces, SQL, Datenbankfehler oder Dateipfade
werden nie gesendet. Mit der `requestId` (auch im Header `X-Request-ID`) lässt sich eine Anfrage im Log finden.

| HTTP | Fehlercodes |
|---|---|
| 400 | `INVALID_REQUEST_BODY`, `INVALID_PARAMETER` |
| 401 | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN` |
| 403 | `ACCOUNT_DISABLED`, `REGISTRATION_DISABLED` |
| 404 | `NOT_FOUND` (auch für Datensätze, Geräte und Sitzungen anderer Benutzer) |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `CONFLICT` (mit `conflict`), `EMAIL_ALREADY_REGISTERED`, `DEVICE_REQUIRED` |
| 410 | `SYNC_CURSOR_EXPIRED` – vollständig neu synchronisieren |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `VALIDATION_FAILED` (mit `details`) |
| 429 | `RATE_LIMITED` (Header `Retry-After`), `ACCOUNT_TEMPORARILY_LOCKED` |
| 500 / 503 | `INTERNAL_ERROR` / Health bzw. Readiness nicht gegeben |

Im Sync-Push-Ergebnis zusätzlich: `OPERATION_ID_REUSED`.

## Datenformate und Felder

- IDs: UUID-Strings. Zeitpunkte: ISO-8601 UTC mit Millisekunden. Kalenderdaten: `YYYY-MM-DD`.
- `createdAt`, `updatedAt`, `deletedAt`: **Serverzeit**. `clientUpdatedAt`: vom Gerät gemeldete Zeit (nur informativ).
- Schreibgeschützt (vom Server erzeugt, gesendete Werte werden ignoriert): `version`, `createdAt`, `updatedAt`,
  `deleted`, `deletedAt`, `weekEnd`, `isoYear`, `isoWeek`, `createdByDeviceId`, `lastModifiedByDeviceId`,
  `lastOperationId`, alle Konto-, Geräte- und Sitzungsfelder außer den änderbaren Geräteangaben.
- Status: `DRAFT`, `GENERATED`, `EDITED`, `FINALIZED`. Schreibstil: `NEUTRAL`, `FORMAL`, `SIMPLE`, `DETAILED`.
- Feldgrenzen (in Zeichen): Tagesbericht-Text 1–5000, Notiz ≤ 2000, `orderIndex` 0–10000, Wochenbericht ≤ 50000,
  Profil-Textfelder ≤ 120 (Betrieb ≤ 160), `clientLocalId` ≤ 64 (`[A-Za-z0-9._:-]`), Gerätename ≤ 100.
  Daten zwischen 2000-01-01 und 2100-12-31.
- Pagination: `page` ≥ 1, `limit` 1–100 (Standard 50). Für große Datenmengen ist der cursorbasierte Sync-Abruf
  gedacht (gemessen: 500 Änderungen in ca. 10 ms bei 300 000 Berichten).

## Zuordnung zur Android-App

| Android (Room) | Server | Hinweis |
|---|---|---|
| `DailyActivityEntity` (`dateEpochDay`, `text`, `note`, `orderIndex`, `createdAt`, `updatedAt`) | `daily_reports` | zusätzlich `status` (Standard `DRAFT`), `version`, UUID; lokale `id` → `clientLocalId`, lokales `updatedAt` → `clientUpdatedAt` |
| `WeeklyReportEntity` (`weekStartEpochDay`, `content`, `status`, `generatedAt`) | `weekly_reports` | `weekEnd`, `isoWeek`, `isoYear` berechnet der Server |
| `UserProfileEntity` | `user_profiles` | `onboardingCompleted` bleibt gerätelokal |
| `ReportVersionEntity` | – | für eine spätere Version geplant |
| Einstellungen (DataStore), KI-Modelle | – | bleiben lokal; der Server enthält keine KI |

`dateEpochDay` ↔ `date`: `LocalDate.ofEpochDay(x).toString()` bzw. `LocalDate.parse(date).toEpochDay()`.

## Geplante Anbindung in Berichtly 2.2 (ohne Pflicht zur Serververbindung)

Die App bleibt **offline-first**: Room ist die führende lokale Datenquelle, der Server eine optionale Erweiterung.

1. **Verbinden**: Serveradresse (nur `https://`) → `POST /auth/register` bzw. `/auth/login` mit `device`
   (einmalig erzeugte UUID in DataStore, Name, `osVersion`, `appVersion`).
2. **Tokens**: Refresh Token verschlüsselt (Android Keystore), Access Token nur im Speicher. Bei `401` einmal
   `POST /auth/refresh` (per Mutex nie parallel), dann wiederholen; schlägt das fehl → neu anmelden.
3. **Room-Migration**: Spalten `remoteId` (UUID), `serverVersion`, `syncState` (`SYNCED`/`DIRTY`/`DELETED`),
   `pendingOperationId`; dazu ein lokal gespeicherter `syncCursor`.
4. **Synchronisieren** (WorkManager, nur mit Netz): Ablauf wie in [SYNC.md](SYNC.md) – `POST /sync` mit allen
   `DIRTY`-Datensätzen (je eine feste `operationId` pro Änderung, bis zur Bestätigung gespeichert), restliche Seiten
   abrufen, lokal übernehmen, `POST /sync/complete`.
5. **Konflikte**: zunächst markieren und dem Benutzer die beiden Fassungen anzeigen.
6. **Geräte & Sitzungen**: Einstellungsseite mit `GET /devices`, `DELETE /devices/{id}`, `POST /auth/logout-all`.
7. **Abmelden**: `POST /auth/logout`; lokale Daten bleiben erhalten.

Bei der ersten Synchronisierung eines bestehenden Datenbestands werden lokale Datensätze mit neu erzeugten UUIDs und
`baseVersion = null` hochgeladen; dank stabiler IDs und `operationId` entstehen auch bei Abbrüchen keine Duplikate.
