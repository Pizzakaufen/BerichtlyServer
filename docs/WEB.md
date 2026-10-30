# Weboberfläche (`/app`, seit 2.2)

Optionale Browser-Oberfläche für Konten. Sie ist eine statische Seite und nutzt ausschließlich die API `/api/v1`
mit derselben Anmeldung wie die Android-App. Der Server speichert dafür nichts zusätzlich.

## Aktivieren
1. `.env`: `WEB_APP_ENABLED=true` (optional `WEB_APP_DIR`, Standard `web/` im Programmverzeichnis).
2. Nginx: im HTTPS-Server-Block `include /etc/nginx/snippets/berichtly-web.conf;` (Vorlage auskommentiert in
   `berichtly-https.conf.template`), dann `nginx -t && systemctl reload nginx`.
3. Dienst neu starten. Aufruf: `https://<domain>/app`.

## Bereiche
Start, Berichte, Woche (Editor), Kalender, PDF (Druckansicht → „Als PDF speichern“ im Browser), KI, Einstellungen
(Darstellung, Profil, Geräte, Datenauskunft, Rechtsseiten, Link zum Admin-Dashboard für Administratoren).

Die KI-Seite erklärt nur: Die KI läuft lokal in der Android-App; der Server hat keine KI, im Browser wird nichts
generiert oder vorgetäuscht.

## Sicherheit und Datenschutz
- Eigene CSP: `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`; keine externen
  Ressourcen, keine Cookies, keine Analyse. Tokens liegen nur im `sessionStorage` (Ende mit dem Tab).
- DOM-Aufbau ohne `innerHTML`; nur Dateien aus `web/` mit erlaubten Typen werden ausgeliefert (beim Start geladen).
- `test/unit/webapp.test.ts` prüft Standard-aus, Dateiliste, CSP, externe Ressourcen und Kontraste (WCAG 2.2 AA).

## Libraries.dev
Übernommen (MIT, © 2026 Jakub Antalik, Lizenztexte in `web/vendor/*/LICENSE`):

| Komponente | Verwendung |
|---|---|
| `thinking-orbs` | Geometrie-Engine unverändert (nur TypeScript-Typen entfernt); `web/fx.js` → `thinkingOrb()` für Anmeldung, Laden, Speichern, Verbindung, KI-Status |
| `border-beam` | `generateBeamCSS()` unverändert; `web/fx.js` → `borderBeam()` als Constructable Stylesheet (CSP-kompatibel) um Anmeldekarte und Editor während laufender Vorgänge |

Nicht übernommen: die React-Komponenten selbst (der Server hat bewusst keinen Build-Schritt; React würde eine
Abhängigkeit und Bundling erfordern), `voice-glow` (Weboberfläche hat keine Spracheingabe), `bot-avatars`, `metal-fx`,
`img-fx`, `liquid-gooey`, `magnetkit` (kein Bedarf bzw. dekorativ) sowie alle Modelldateien `.mfxl`
(eigene Modell-Lizenz). Neu einspielen: `node scripts/vendor-libraries.mjs <Pfad zu Libraries.dev>`.
