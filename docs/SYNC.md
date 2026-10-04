# Synchronisierung – Konzept und Ablauf

Berichtly Server 1.0 Alpha stellt die **Server-Grundlage** der Synchronisierung bereit. Die Android-App
synchronisiert in dieser Version noch nicht; dieses Dokument beschreibt, wie sie es später tun soll.

## Grundbausteine

| Baustein | Zweck |
|---|---|
| **UUID je Datensatz** | Stabile ID, die das Gerät selbst erzeugen kann – unabhängig vom lokalen Room-Autoincrement. Die App speichert sie zusätzlich zu ihrer lokalen `id`. |
| **`version`** | Beginnt bei 1 und steigt bei jeder Änderung auf dem Server um 1. Grundlage der Konflikterkennung (optimistische Sperre). |
| **`changeSeq`** | Globale, streng monoton steigende Änderungsnummer (PostgreSQL-Sequence, per Trigger gesetzt). Dient als Cursor: "alles nach Nummer X". |
| **`updatedAt`** | Zeitpunkt der letzten Änderung (UTC, Datenbankuhr). Nur informativ – Entscheidungen basieren auf `version`/`changeSeq`, nicht auf Gerätezeit. |
| **Tombstone (`deleted`)** | Löschen ist ein Soft-Delete: Der Datensatz bleibt mit `deletedAt` erhalten (Inhalt geleert), damit andere Geräte die Löschung erfahren. |
| **Geräte-ID** | Beim Login übermittelte UUID; der Server merkt sich je Gerät letzten Pull, Cursor und Push. |

Synchronisiert werden `DAILY_REPORT`, `WEEKLY_REPORT` und `PROFILE`.

## Änderungen abrufen (Pull)

```
GET /api/v1/sync/changes?cursor=<lokal gespeicherter Cursor>&limit=200
```

```json
{ "data": {
  "changes": [
    { "type": "DAILY_REPORT", "id": "…", "version": 3, "changeSeq": 1042, "deleted": false,
      "updatedAt": "2026-10-05T08:15:00.000Z", "data": { "…": "wie GET /daily-reports/{id}" } },
    { "type": "DAILY_REPORT", "id": "…", "version": 4, "changeSeq": 1043, "deleted": true,
      "updatedAt": "…", "data": null }
  ],
  "nextCursor": "1043", "hasMore": false, "serverTime": "…"
} }
```

Ablauf in der App:

1. Erste Synchronisierung mit `cursor=0` (liefert alles inklusive Tombstones).
2. Änderungen lokal in einer Room-Transaktion übernehmen.
3. **Erst danach** `nextCursor` lokal speichern.
4. Solange `hasMore = true`: mit dem neuen Cursor weiter abrufen.

**Warum keine Änderung verloren geht:** Alle Schreibvorgänge eines Kontos werden über eine Sperre auf der
Benutzerzeile serialisiert. Änderungsnummern werden dadurch in Commit-Reihenfolge vergeben – ein Client kann nie
eine höhere Nummer sehen, bevor eine niedrigere desselben Kontos sichtbar ist.

## Lokale Änderungen hochladen (Push)

```
POST /api/v1/sync/push
{ "changes": [
  { "type": "DAILY_REPORT", "operation": "UPSERT", "id": "<uuid>", "baseVersion": null,
    "data": { "date": "2026-10-05", "text": "…", "note": "", "orderIndex": 0, "status": "DRAFT" } },
  { "type": "DAILY_REPORT", "operation": "UPSERT", "id": "<uuid>", "baseVersion": 2, "data": { "…": "…" } },
  { "type": "WEEKLY_REPORT", "operation": "DELETE", "id": "<uuid>", "baseVersion": 5 },
  { "type": "PROFILE", "operation": "UPSERT", "id": "<eigene Benutzer-ID>", "baseVersion": 1, "data": { "…": "…" } }
] }
```

- `baseVersion: null` = lokal neu. Sonst die Serverversion, auf der die lokale Änderung beruht.
- Maximal 100 Änderungen pro Anfrage. Jede wird **einzeln und atomar** verarbeitet; ein Konflikt blockiert die anderen nicht.
- `data` hat dasselbe Format wie bei den REST-Endpunkten.

| `status` | Bedeutung | Was die App tut |
|---|---|---|
| `APPLIED` | Übernommen (oder war bereits identisch vorhanden) | `version` aus der Antwort speichern, Datensatz als synchronisiert markieren |
| `CONFLICT` | Serverstand weicht ab – **nichts wurde überschrieben** | `conflict.serverRecord` mit der lokalen Fassung vergleichen; später den Benutzer entscheiden lassen |
| `REJECTED` | Ungültig (Validierung, unbekannte ID …) | Fehler anzeigen bzw. protokollieren, nicht endlos wiederholen |

## Konfliktregeln

| Situation | Ergebnis |
|---|---|
| Neu, ID existiert noch nicht | `APPLIED`, Version 1 |
| Neu, ID existiert mit **identischem** Inhalt (Wiederholung nach Verbindungsabbruch) | `APPLIED` (idempotent, keine neue Version) |
| Neu, ID existiert mit anderem Inhalt | `CONFLICT` `ALREADY_EXISTS` |
| Änderung, `baseVersion` = Serverversion | `APPLIED`, Version + 1 |
| Änderung, Version weicht ab, Inhalt identisch | `APPLIED` (bereits auf diesem Stand) |
| Änderung, Version weicht ab, Inhalt verschieden | `CONFLICT` `VERSION_MISMATCH` + Serverstand |
| Änderung an einem auf dem Server gelöschten Datensatz | `CONFLICT` `DELETED_ON_SERVER` |
| Löschen mit veralteter Version | `CONFLICT` `VERSION_MISMATCH` (neuere Änderung wird nicht stillschweigend gelöscht) |
| Löschen eines bereits gelöschten Datensatzes | `APPLIED` (idempotent) |
| Zweiter aktiver Wochenbericht derselben Woche | `CONFLICT` `DUPLICATE_WEEK` + vorhandener Bericht |
| ID gehört einem anderen Konto | `CONFLICT` `ID_UNAVAILABLE` (ohne Daten) bzw. `REJECTED` `NOT_FOUND` |

Dieselben Regeln gelten für die REST-Endpunkte (`PUT`/`DELETE` mit Version → `409 CONFLICT`). Eine spätere
App-Version kann daraus eine Benutzerentscheidung machen: "Server-Fassung behalten" → Serverstand übernehmen;
"Meine Fassung behalten" → erneut senden mit `baseVersion = serverVersion`.

## Sync-Status

`GET /api/v1/sync/status` liefert `serverCursor` (höchste Änderungsnummer des Kontos) und für das aktuelle Gerät
`lastPullAt`, `lastPullCursor` und `lastPushAt`. Die App kann damit anzeigen, wann zuletzt erfolgreich
synchronisiert wurde und ob es auf dem Server Neues gibt (`serverCursor` > lokaler Cursor). Ob **lokal** Änderungen
ausstehen, weiß nur die App selbst (z. B. Spalte `syncState = DIRTY` in Room).

## Was der Server bewusst nicht tut

- Er löscht nie Daten, weil ein Gerät lange offline war. Löschungen entstehen nur durch ausdrückliche
  `DELETE`-Operationen und bleiben als Tombstone nachvollziehbar.
- Er entscheidet Konflikte nicht anhand von Gerätezeiten ("last write wins").
- Tombstones werden in 1.0 Alpha nicht automatisch bereinigt. Eine spätere Bereinigung muss sicherstellen, dass
  alle Geräte die Löschung bereits abgerufen haben (z. B. über `devices.last_pull_cursor`).
