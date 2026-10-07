# Synchronisierung – Konzept und Protokoll (Berichtly Server 1.2)

Berichtly Server stellt seit 1.1 die vollständige **Server-Seite** der Synchronisierung bereit. Die Android-App
(Berichtly 2.2) synchronisiert noch nicht; dieses Dokument beschreibt das Protokoll, das ihr API-Client umsetzen soll.
Alle hier beschriebenen Abläufe sind durch Integrationstests gegen PostgreSQL abgesichert
(`test/integration/sync*.test.ts`); 1.2 hat das Protokoll unverändert übernommen.

## Grundbausteine

| Baustein | Zweck |
|---|---|
| **UUID je Datensatz** | Stabile ID, vom Gerät erzeugt – unabhängig vom lokalen Room-Autoincrement und bei jeder Synchronisierung gleich. Die App speichert sie zusätzlich zu ihrer lokalen `id`. |
| **`version`** | Beginnt bei 1, steigt bei jeder Änderung auf dem Server um 1. Grundlage der Konflikterkennung (optimistische Sperre). |
| **`changeSeq` / Cursor** | Streng monoton steigende Änderungsnummer (PostgreSQL-Sequence, per Trigger). Der Cursor sagt: "alles nach Nummer X". |
| **`operationId`** | UUID je lokaler Änderung, bei jeder Wiederholung identisch. Der Server führt jede Operation genau einmal aus. |
| **Tombstone** | Löschen ist ein Soft-Delete: `deleted: true`, Inhalt geleert, ID/Version bleiben – damit andere Geräte die Löschung erfahren. |
| **Serverzeit vs. Clientzeit** | `createdAt`/`updatedAt` sind Serverzeit (UTC). `clientUpdatedAt` ist die Zeit laut Gerät – nur informativ, nie Grundlage von Entscheidungen. |
| **Herkunft** | `clientLocalId` (lokale ID, z. B. Room-ID), `createdByDeviceId`, `lastModifiedByDeviceId`, `lastOperationId` machen nachvollziehbar, woher ein Stand stammt. |
| **Gerät** | Stabile Geräte-UUID (Login mit `device` oder `POST /devices`). Pro Gerät speichert der Server den Synchronisationsstatus. |

Synchronisiert werden `DAILY_REPORT`, `WEEKLY_REPORT` und `PROFILE`.

## Empfohlener Ablauf in der App

```
1. POST /api/v1/sync        { cursor, limit, changes: [ … lokal geänderte Datensätze … ] }
      → push.results  : Ergebnis je lokaler Änderung (APPLIED / CONFLICT / REJECTED)
      → pull.changes  : Serveränderungen ab cursor (eigene Änderungen als echo: true markiert)
      → pull.nextCursor, pull.hasMore
2. Solange hasMore:  GET /api/v1/sync/changes?cursor=<nextCursor>&limit=…
3. Alles lokal in einer Room-Transaktion übernehmen, erst DANACH den Cursor speichern.
4. POST /api/v1/sync/complete { result: "SUCCESS", cursor, unresolvedConflicts }
   bzw. bei Abbruch          { result: "FAILED", errorCode: "NETWORK_ERROR" }
```

Mehr als 100 lokale Änderungen werden in mehreren `POST /sync`-Aufrufen übertragen (je max. 100).

### Änderungen hochladen

```json
{ "cursor": "1043", "limit": 200, "changes": [
  { "operationId": "6c1f…", "type": "DAILY_REPORT", "operation": "UPSERT", "id": "<uuid>", "baseVersion": null,
    "clientUpdatedAt": "2026-10-05T07:00:00.000Z", "clientLocalId": "room:42",
    "data": { "date": "2026-10-05", "text": "…", "note": "", "orderIndex": 0, "status": "DRAFT" } },
  { "operationId": "9a2b…", "type": "DAILY_REPORT", "operation": "UPSERT", "id": "<uuid>", "baseVersion": 2, "data": { } },
  { "operationId": "d4e5…", "type": "WEEKLY_REPORT", "operation": "DELETE", "id": "<uuid>", "baseVersion": 5 },
  { "operationId": "f00d…", "type": "PROFILE", "operation": "UPSERT", "id": "<eigene Benutzer-ID>", "baseVersion": 1, "data": { } }
] }
```

- `baseVersion: null` = lokal neu; sonst die Serverversion, auf der die lokale Änderung beruht.
- Jede Änderung wird **einzeln und atomar** verarbeitet; ein Konflikt blockiert die anderen nicht.
- `data` hat dasselbe Format wie die REST-Endpunkte.

| `status` | Bedeutung | Was die App tut |
|---|---|---|
| `APPLIED` | Übernommen oder bereits identisch vorhanden (`replayed: true` = Wiederholung einer bereits verarbeiteten `operationId`) | `version` speichern, Datensatz als synchronisiert markieren |
| `CONFLICT` | Serverstand weicht ab – **nichts wurde überschrieben** | Konflikt merken (`conflict.serverRecord`), Benutzer entscheiden lassen |
| `REJECTED` | Ungültig (Validierung, unbekannte ID, `OPERATION_ID_REUSED` …) | Fehler anzeigen/protokollieren, nicht endlos wiederholen |

### Idempotenz und Netzwerkabbrüche

- **Antwort geht verloren:** Dieselbe Anfrage mit denselben `operationId`s erneut senden. Bereits verarbeitete
  Operationen werden nicht erneut ausgeführt; der Server liefert das ursprüngliche Ergebnis (`replayed: true`) –
  auch dann, wenn der Bericht inzwischen von einem anderen Gerät weiter geändert wurde.
- **Gleichzeitige Wiederholungen** (z. B. zwei parallele Requests derselben Operation) werden serialisiert; es
  entsteht genau ein Datensatz.
- **Dieselbe `operationId` für eine andere Änderung** wird mit `OPERATION_ID_REUSED` abgelehnt.
- **Ohne `operationId`** (Kompatibilität mit 1.0) gilt: identischer Inhalt = idempotent; nach einer zwischen-
  zeitlichen Änderung durch ein anderes Gerät meldet der Server dann allerdings einen Konflikt. Deshalb immer
  `operationId` senden.
- **Abbruch beim Herunterladen:** Den Cursor erst nach erfolgreicher lokaler Übernahme speichern. Ein erneuter
  Abruf mit dem alten Cursor liefert dieselben Daten – nichts fehlt, nichts doppelt.

Idempotenz-Einträge werden `SYNC_OPERATION_RETENTION_DAYS` (Standard 30) Tage aufbewahrt; sie enthalten nur
Status, Version und Konfliktgrund, keinen Berichtsinhalt.

## Konfliktregeln

| Situation | Ergebnis |
|---|---|
| Neu, ID existiert noch nicht | `APPLIED`, Version 1 |
| Neu, ID existiert mit **identischem** Inhalt | `APPLIED` (idempotent, keine neue Version) |
| Neu, ID existiert mit anderem Inhalt | `CONFLICT` `ALREADY_EXISTS` |
| Änderung, `baseVersion` = Serverversion | `APPLIED`, Version + 1 |
| Änderung, Version weicht ab, Inhalt identisch | `APPLIED` (bereits auf diesem Stand) |
| Änderung, Version weicht ab, Inhalt verschieden | `CONFLICT` `VERSION_MISMATCH` + Serverstand |
| Änderung an einem auf dem Server gelöschten Datensatz | `CONFLICT` `DELETED_ON_SERVER` |
| Löschen mit veralteter Version | `CONFLICT` `VERSION_MISMATCH` (die neuere Änderung wird nicht stillschweigend gelöscht) |
| Löschen eines bereits gelöschten Datensatzes | `APPLIED` (idempotent) |
| Zweiter aktiver Wochenbericht derselben Woche | `CONFLICT` `DUPLICATE_WEEK` + vorhandener Bericht |
| ID gehört einem anderen Konto | `CONFLICT` `ID_UNAVAILABLE` (ohne Daten) bzw. `REJECTED` `NOT_FOUND` |

Dieselben Regeln gelten für die REST-Endpunkte (`PUT`/`DELETE` mit Version → `409 CONFLICT`). Der Server
entscheidet Konflikte **nie** selbst (kein Last-Write-Wins anhand von Uhrzeiten). Auflösung in der App:

- "Server-Fassung behalten" → `conflict.serverRecord` lokal übernehmen.
- "Meine Fassung behalten" → erneut senden mit `baseVersion = conflict.serverVersion` (neue `operationId`).

## Synchronisationsstatus pro Gerät

`POST /sync/complete` (oder `GET /sync/status`, `GET /devices`) liefert je Gerät:

| `syncStatus` | Bedeutung |
|---|---|
| `NEVER` | Noch nie eine Synchronisierung abgeschlossen |
| `SUCCESS` | Letzte Synchronisierung erfolgreich, keine offenen Konflikte |
| `FAILED` | Letzter Versuch fehlgeschlagen (`lastFailedSyncAt`, `lastSyncErrorCode`); `lastSyncAt` bleibt auf dem letzten Erfolg |
| `CONFLICT` | Abgeschlossen, aber mit `unresolvedConflicts` > 0 |

Weitere Felder: `lastSyncAt` (letzter Erfolg), `lastSuccessfulCursor`, `lastSyncStartedAt` (Beginn des letzten
Vorgangs – liegt er nach `lastSyncAt` und `lastFailedSyncAt`, läuft ein Vorgang oder wurde abgebrochen),
`lastPullAt`, `lastPushAt`. Ein fehlgeschlagener Vorgang wird nie als Erfolg gespeichert. Ob **lokal** noch
Änderungen ausstehen, weiß nur die App (z. B. Spalte `syncState = DIRTY` in Room).

`POST /sync/complete` erfordert eine an ein Gerät gebundene Sitzung (sonst `409 DEVICE_REQUIRED`).

## Cursor, Epochen und Aufbewahrung von Löschungen

Cursor sind für die App **undurchsichtige Strings** und werden unverändert zurückgegeben: `"1043"` oder – sobald
der Server einmal Löschinformationen bereinigt hat – `"1043.2"` (Nummer.Epoche). Cursor aus 1.0 bleiben gültig.

**Aufbewahrung:** Tombstones bleiben `TOMBSTONE_RETENTION_DAYS` (Standard **365 Tage**) erhalten. Danach entfernt
die Wartung (automatisch alle `MAINTENANCE_INTERVAL_HOURS` Stunden oder per `berichtly-server maintenance`) sie
endgültig und erhöht die Cursor-Epoche.

Ein Gerät, das so lange nicht synchronisiert hat, dass es eine bereinigte Löschung verpasst haben könnte, erhält
`410 SYNC_CURSOR_EXPIRED`. Es muss dann vollständig neu synchronisieren:

1. `cursor=0` abrufen (alle Seiten). Das Ergebnis ist der vollständige aktuelle Serverstand.
2. Lokale Datensätze, die als synchronisiert markiert sind, aber im Serverstand fehlen, wurden auf dem Server
   gelöscht → lokal löschen.
3. Lokal noch nicht synchronisierte Änderungen (`DIRTY`) normal hochladen.

Cursor, die während der Neusynchronisierung ausgestellt werden, sind immer gültig (aktuelle Epoche). Geräte, die
regelmäßig synchronisieren, sind von der Bereinigung nicht betroffen.

Nach dem **Einspielen eines Backups** muss der Betreiber `berichtly-server reset-sync-cursors` ausführen
(docs/BACKUP.md); danach synchronisieren alle Geräte einmal vollständig neu.

## Warum keine Änderung verloren geht

- Alle Schreibvorgänge eines Kontos werden über eine Sperre auf der Benutzerzeile serialisiert; Änderungsnummern
  werden dadurch in Commit-Reihenfolge vergeben.
- Ein Abruf liest alle Tabellen aus **einem** konsistenten Datenbank-Snapshot (REPEATABLE READ). Ohne das könnte
  eine zwischen zwei Abfragen committete Änderung übersprungen werden (in 1.0 Alpha gefunden und in 1.1 behoben;
  Regressionstest sync-consistency: „Pull verliert keine Änderungen bei gleichzeitigen Schreibvorgängen“).

## Was der Server bewusst nicht tut

- Er löscht nie Daten, weil ein Gerät offline war. Löschungen entstehen nur durch ausdrückliche `DELETE`-Operationen.
- Er entscheidet Konflikte nicht anhand von Gerätezeiten.
- Er speichert keine Berichtsinhalte in Idempotenz-Einträgen, Sicherheitsereignissen oder Logs.

## Getestete Szenarien

| Szenario | Test |
|---|---|
| Neues Gerät mit leerer Datenbank, bestehendes Berichtsheft (250 Berichte, mehrere Pakete/Seiten) | sync-scenarios: „neues Gerät mit bestehendem Berichtsheft“ |
| Änderungen auf mehreren Geräten, Löschung erreicht alle Geräte | sync-scenarios: „Änderungen auf mehreren Geräten und Löschung“ |
| Echter Konflikt zwischen zwei Geräten inkl. Auflösung | sync-scenarios: „echter Konflikt zwischen zwei Geräten“ |
| Wiederholte Operation, verlorene Antwort, abgebrochener Abruf, fehlgeschlagener Sync | sync-scenarios: „wiederholte Operation und Netzwerkabbruch“ |
| Gleichzeitige doppelte Übertragung | sync-scenarios: „gleichzeitige doppelte Übertragung erzeugt kein Duplikat“ |
| Gleichzeitige Schreibvorgänge während des Abrufs | sync-consistency: „Pull verliert keine Änderungen bei gleichzeitigen Schreibvorgängen“ |
| Abgelaufener Cursor, mehrseitige Neusynchronisierung | sync-scenarios: „abgelaufener Cursor nach Tombstone-Bereinigung“ |
| Wiederherstellung aus Backup | sync-scenarios: „Cursor zurücksetzen nach Wiederherstellung“ |
