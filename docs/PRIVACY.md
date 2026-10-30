# Datenschutz und Datenflüsse – Berichtly Server 2.1

Diese Übersicht beschreibt das tatsächliche technische Verhalten des Servers (geprüft am Quellcode, Stand 2.1).
Sie ist **keine Datenschutzerklärung**. Wer den Server anderen Personen anbietet, muss eine eigene
Datenschutzerklärung verfassen (siehe [LEGAL.md](LEGAL.md)). Für diese Übersicht kann sie als Faktengrundlage dienen.

## Welche Daten der Server speichert

| Bereich | Daten | Zweck | Löschung |
|---|---|---|---|
| Konto (`users`) | E-Mail, Passwort-Hash, Status, Rolle, Zeitzone, Fehlversuche/Sperre, letzte Anmeldung | Anmeldung, Schutz vor Missbrauch | Kontolöschung (App oder `DELETE /api/v1/account`) |
| Profil (`user_profiles`) | Name, Beruf, Betrieb, Abteilung, Ausbilder, Ausbildungszeitraum, Schreibstil | Synchronisierung mit der App | mit dem Konto |
| Berichte (`daily_reports`, `weekly_reports`) | Tätigkeiten mit Notiz, Status und Datum, Wochenberichte | Synchronisierung | mit dem Konto; gelöschte Einträge (Tombstones) nach `TOMBSTONE_RETENTION_DAYS` (Standard 365) |
| Geräte (`devices`) | Installations-ID, Gerätebezeichnung (seit App 4.1 nur Hersteller und Modell), Android- und App-Version, Synchronisationsstatus und Fehlercode | Geräteverwaltung, Fehlersuche | mit dem Konto oder beim Abmelden des Geräts |
| Sitzungen, Refresh Tokens | Zeitpunkte, Ablauf, Widerrufsgrund; Tokens nur als SHA-256-Hash | Anmeldung | abgelaufene nach `SESSION_RETENTION_DAYS` (Standard 30) |
| Sicherheitsereignisse | Ereignistyp, Zeitpunkt, Sitzung, Gerät – **keine IP-Adresse** | Nachvollziehbarkeit von Anmeldungen | nach `SECURITY_EVENT_RETENTION_DAYS` (Standard 180) |
| Sync-Operationen | Operations-ID, Ergebnis | Idempotenz | nach `SYNC_OPERATION_RETENTION_DAYS` (Standard 30) |
| Admin-Sitzungen | Token-Hash, Zeitpunkte | Dashboard-Anmeldung | 7 Tage nach Ablauf |
| Verwaltungsprotokoll | Admin, Aktion, Zielkonto, Zeitpunkt | Nachvollziehbarkeit | nach `ADMIN_AUDIT_RETENTION_DAYS` (Standard 365, **neu in 2.1**) |
| Backup-Protokoll | Dateiname, Größe, Prüfsumme, Ergebnis – keine Inhalte | Betrieb | manuell |

**Nicht** gespeichert werden: KI-Eingaben (die App hat keine Server-KI), Lernfortschritt, Einstellungen der App,
PDF-Dateien und Audiodaten.

## Protokolle (Logs)

- **Node.js:** strukturierte Zeilen mit Request-ID, Methode, Pfad ohne Query-String, Status, Dauer und Benutzer-ID.
  Es werden weder Berichtsinhalte noch Passwörter, Tokens oder Request-Bodies protokolliert. Aufbewahrung über
  journald ([OPERATIONS.md](OPERATIONS.md): `MaxRetentionSec`).
- **Nginx:** Zugriffslog mit IP-Adresse, Zeitpunkt, Pfad ohne Query-String, Status und User-Agent (Format
  `berichtly_json`). Zweck: Abwehr von Missbrauch und Fehlersuche. Aufbewahrung über logrotate (Debian/Ubuntu-Standard
  14 Tage). Wer kürzer aufbewahren will, setzt `rotate` in `/etc/logrotate.d/nginx` entsprechend herunter.
- **Backups** enthalten alle Daten der Datenbank. Nach einer Kontolöschung bleiben die Daten in bestehenden
  Backups, bis diese nach der Aufbewahrungsfrist von `deploy/backup.sh` gelöscht werden ([BACKUP.md](BACKUP.md)).

## Cookies und Speicherung auf Endgeräten

| Oberfläche | Technik | Notwendig? |
|---|---|---|
| API (`/api/v1`) | keine Cookies; Anmeldung per Bearer-Token im App-Speicher | – |
| Admin-Dashboard (`/admin`) | ein Sitzungs-Cookie `__Host-berichtly_admin` (HttpOnly, Secure, SameSite=Strict) | ja – nur für die ausdrücklich gewünschte Anmeldung |
| Rechtsseiten (`/legal/…`), `/api/docs` | keine Cookies, kein Local/Session Storage, kein JavaScript | – |

**Ergebnis:** Es gibt keine optionalen Cookies und keine vergleichbaren Technologien (kein Analytics, kein Tracking,
keine Einbettungen). Das Sitzungs-Cookie ist für den vom Administrator ausdrücklich gewünschten Dienst unbedingt
erforderlich. Nach § 25 Abs. 2 Nr. 2 TDDDG ist dafür keine Einwilligung nötig. Deshalb gibt es **kein Cookie-Banner**.
Kommt später eine optionale Technik hinzu (z. B. Analyse), muss vorher ein Einwilligungsmanagement eingebaut werden.

## Externe Verbindungen des Servers

Der Server baut selbst **keine** Verbindungen zu Drittanbietern auf. Ausgehende Verbindungen bestehen nur zur
eigenen PostgreSQL-Datenbank und, beim Einrichten von HTTPS, von Certbot zu Let's Encrypt (Betrieb, nicht Teil des
Node.js-Servers). Seit 2.1 lädt auch `/api/docs` nichts mehr von `unpkg.com`. Der Unit-Test `test/unit/privacy.test.ts`
prüft, dass in `src/http` keine Verweise auf CDN-, Schrift- oder Analysedienste stehen.

Die Datenbank ist in allen Vorlagen nur über `127.0.0.1` bzw. das interne Docker-Netz erreichbar. Nginx leitet nur
`/api/`, `/legal/` und, wenn ausdrücklich eingebunden, `/admin` weiter; alles andere beantwortet es mit 404.

## Rechte der Benutzer (technische Umsetzung)

| Recht | Umsetzung |
|---|---|
| Auskunft / Datenübertragbarkeit (Art. 15, 20 DSGVO) | `GET /api/v1/account/export` – JSON mit allen gespeicherten Daten (ohne Hashes) |
| Löschung (Art. 17 DSGVO) | `DELETE /api/v1/account` mit Passwort und `confirm: "DELETE"`; in der App (ab 4.1) unter Sync Center → Konto auf dem Server löschen |
| Berichtigung (Art. 16 DSGVO) | über die App (Profil, Berichte) |

Administratorkonten lassen sich nicht über die API löschen. Zuerst `berichtly-server admin revoke <E-Mail>`.
