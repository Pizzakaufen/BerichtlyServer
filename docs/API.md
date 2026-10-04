# API und geplante Anbindung der Android-App

Vollständige Referenz: [`api/openapi.yaml`](../api/openapi.yaml), im Entwicklungsmodus auch als Swagger UI unter `/api/docs`.

## Versionierung

Alle Endpunkte liegen unter **`/api/v1`**. Innerhalb von v1 gibt es nur abwärtskompatible Änderungen (neue
Endpunkte, neue optionale Felder). Der Server ignoriert unbekannte Felder in Anfragen, damit neuere App-Versionen
mit älteren Servern funktionieren; die App sollte unbekannte Felder in Antworten ebenfalls ignorieren
(`ignoreUnknownKeys = true`). Inkompatible Änderungen erscheinen unter `/api/v2`, während v1 für bestehende
App-Versionen weiterläuft.

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

`code` ist stabil und maschinenlesbar, `message` für Menschen. Stacktraces, SQL oder interne Details werden nie
gesendet. Mit der `requestId` (auch im Header `X-Request-ID`) lässt sich eine Anfrage im Server-Log wiederfinden.

| HTTP | Fehlercodes |
|---|---|
| 400 | `INVALID_REQUEST_BODY`, `INVALID_PARAMETER` |
| 401 | `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN` |
| 403 | `ACCOUNT_DISABLED`, `REGISTRATION_DISABLED` |
| 404 | `NOT_FOUND` (auch für Datensätze anderer Benutzer) |
| 405 | `METHOD_NOT_ALLOWED` |
| 409 | `CONFLICT` (mit `conflict`), `EMAIL_ALREADY_REGISTERED` |
| 413 / 415 | `PAYLOAD_TOO_LARGE` / `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `VALIDATION_FAILED` (mit `details`) |
| 429 | `RATE_LIMITED` (mit Header `Retry-After`), `ACCOUNT_TEMPORARILY_LOCKED` |
| 500 / 503 | `INTERNAL_ERROR` / Health-Check `unavailable` |

## Datenformate

- IDs: UUID-Strings. Zeitpunkte: ISO-8601 UTC mit Millisekunden. Kalenderdaten: `YYYY-MM-DD`.
- Status (identisch zur App): `DRAFT`, `GENERATED`, `EDITED`, `FINALIZED`.
- Schreibstil: `NEUTRAL`, `FORMAL`, `SIMPLE`, `DETAILED`.
- Feldgrenzen (in Zeichen): Tagesbericht-Text 1–5000, Notiz ≤ 2000, `orderIndex` 0–10000, Wochenbericht ≤ 50000,
  Profil-Textfelder ≤ 120 (Betrieb ≤ 160). Daten zwischen 2000-01-01 und 2100-12-31.

## Zuordnung zur Android-App

| Android (Room) | Server | Hinweis |
|---|---|---|
| `DailyActivityEntity` (`dateEpochDay`, `text`, `note`, `orderIndex`, `createdAt`, `updatedAt`) | `daily_reports` | zusätzlich `status` (Standard `DRAFT`), `version`, UUID |
| `WeeklyReportEntity` (`weekStartEpochDay`, `content`, `status`, `generatedAt`) | `weekly_reports` | `weekEnd`, `isoWeek`, `isoYear` berechnet der Server |
| `UserProfileEntity` | `user_profiles` | `onboardingCompleted` bleibt gerätelokal |
| `ReportVersionEntity` | – | für eine spätere Version geplant |
| Einstellungen (DataStore), KI-Modelle | – | bleiben lokal; der Server enthält keine KI |

`dateEpochDay` ↔ `date`: `LocalDate.ofEpochDay(x).toString()` bzw. `LocalDate.parse(date).toEpochDay()`.

## Geplante Anbindung (ohne Pflicht zur Serververbindung)

Die App bleibt **offline-first**: Room ist die führende lokale Datenquelle, der Server eine optionale Erweiterung,
die in den Einstellungen aktiviert wird.

1. **Verbinden**: Serveradresse (nur `https://`) eingeben → `POST /auth/register` oder `/auth/login` mit
   `device.id` (einmalig erzeugte UUID, in DataStore gespeichert), `device.name`, `device.appVersion`.
2. **Tokens speichern**: Refresh Token verschlüsselt (Android Keystore), Access Token nur im Speicher. Bei `401`
   einmal `POST /auth/refresh`, dann die Anfrage wiederholen; schlägt das fehl, neu anmelden. Immer das zuletzt
   erhaltene Refresh Token speichern und Refresh-Aufrufe nie parallel ausführen (Mutex).
3. **Lokales Schema erweitern** (Room-Migration): `remoteId` (UUID), `serverVersion`, `syncState`
   (`SYNCED`/`DIRTY`/`DELETED`), lokaler `syncCursor`.
4. **Synchronisieren** (z. B. WorkManager, nur mit Netz): erst Push aller `DIRTY`-Datensätze, dann Pull ab Cursor
   (siehe [SYNC.md](SYNC.md)). Konflikte zunächst nur markieren, später dem Benutzer zur Entscheidung anbieten.
5. **Abmelden**: `POST /auth/logout`; lokale Daten bleiben erhalten.

Bei der ersten Synchronisierung eines bestehenden Datenbestands werden lokale Datensätze mit neu erzeugten UUIDs
und `baseVersion = null` hochgeladen; dank idempotenter Erstellung entstehen auch bei Abbrüchen keine Duplikate.
