# Rechtliche Informationsseiten – Entscheidungshilfe für Betreiber

> **ENTWURF – vom Betreiber zu prüfen. Keine Rechtsberatung.** Diese Datei fasst die Pflichten zusammen, die nach
> der technischen Prüfung von Berichtly in Betracht kommen. Ob und welche Pflichten gelten, hängt davon ab, **wer**
> den Server **für wen** betreibt. Das kann nur der Betreiber entscheiden, im Zweifel mit rechtlicher Beratung.
> Geprüft am 29.10.2026 anhand von gesetze-im-internet.de (§ 5 DDG, § 25 TDDDG, § 1 BFSG).

## Was Berichtly tatsächlich ist (Faktenlage)

- Kostenlose Android-App, Daten lokal; der Server ist **optional** und wird **selbst gehostet**.
- Keine Zahlungen, keine In-App-Käufe, keine Abonnements, kein App-Store-Vertrieb durch das Projekt bekannt.
- Keine Werbung, kein Tracking, keine Analyse, keine Einbettungen, keine Drittanbieter-Schriften ([PRIVACY.md](PRIVACY.md)).
- Das Admin-Dashboard setzt nur ein technisch notwendiges Sitzungs-Cookie.

## Pflichten nach Einsatzszenario

| Szenario | Impressum (§ 5 DDG) | Datenschutzhinweise (Art. 13 DSGVO) | Cookie-Banner (§ 25 TDDDG) |
|---|---|---|---|
| A: Server nur für sich selbst (privat) | nein – kein geschäftsmäßiger Dienst | in der Regel nein – rein persönliche Tätigkeit (Art. 2 Abs. 2 lit. c DSGVO) | nein |
| B: Server für andere, z. B. Mitauszubildende, unentgeltlich und privat | nach § 5 DDG nur bei „geschäftsmäßigen, in der Regel gegen Entgelt angebotenen" Diensten – im Einzelfall zu prüfen | **ja** – Verarbeitung personenbezogener Daten Dritter | nein (nur notwendiges Cookie) |
| C: Betrieb durch einen Ausbildungsbetrieb / ein Unternehmen | **ja** | **ja**, zusätzlich Verzeichnis von Verarbeitungstätigkeiten, ggf. Auftragsverarbeitung mit dem Hoster | nein |
| D: kostenpflichtiges Angebot | **ja** | **ja** | nein |

**Widerruf/Rückerstattung, AGB mit Zahlungsregeln:** Berichtly hat keine kostenpflichtigen Leistungen. Deshalb gibt
es bewusst **keine** Widerrufs- oder Rückerstattungsseite. Für ein späteres Bezahlangebot müssen Leistungsbeschreibung,
Laufzeit, Kündigung, Zahlungsanbieter und Verbraucherinformationen zuerst feststehen.

**Barrierefreiheit (BFSG):** Das Barrierefreiheitsstärkungsgesetz gilt seit 28.06.2025 für bestimmte Produkte und
Dienstleistungen für Verbraucher (u. a. Dienstleistungen im elektronischen Geschäftsverkehr). Ein kostenloses,
selbst gehostetes Berichtsheft ohne Vertragsabschluss fällt nach der Aufzählung in § 1 Abs. 3 BFSG voraussichtlich
nicht darunter; das ist vom Betreiber zu prüfen. Unabhängig davon orientieren sich App und Dashboard an
WCAG 2.2 AA als freiwilligem Qualitätsziel.

## Was der Server anbietet

- `LEGAL_IMPRINT_FILE` und `LEGAL_PRIVACY_FILE` (`.env`): absolute Pfade zu Textdateien, die der Betreiber **selbst**
  schreibt. Der Server zeigt sie unter `/legal/impressum` bzw. `/legal/datenschutz` an (Text wird vollständig
  maskiert). Über `GET /api/v1/legal` erfährt die App (ab 4.1) die Pfade und verlinkt sie nach „Server prüfen“ im Anmeldeformular.
- Ohne Dateien existieren die Seiten nicht (404). Der Server erzeugt **keine** Platzhalter, die wie eine fertige
  Rechtsseite aussehen.

## Offene Angaben, die nur der Betreiber liefern kann

Für Szenario B–D vor der Veröffentlichung zu klären und selbst in die Textdateien einzutragen:

- [ ] Wer ist Betreiber und Verantwortlicher (Name bzw. Firma, Rechtsform, Vertretungsberechtigte)?
- [ ] Ladungsfähige Anschrift
- [ ] Schnelle elektronische Kontaktmöglichkeit (E-Mail-Adresse)
- [ ] Ggf. Registereintrag, USt-IdNr., Aufsichtsbehörde
- [ ] Ggf. Datenschutzbeauftragter
- [ ] Hoster des Servers (Auftragsverarbeiter, Standort), Vertrag zur Auftragsverarbeitung
- [ ] Rechtsgrundlage der Verarbeitung (z. B. Vertrag/Nutzungsverhältnis, Art. 6 Abs. 1 lit. b DSGVO, oder
      bei Betrieb durch den Ausbildungsbetrieb das Beschäftigungsverhältnis)
- [ ] Tatsächliche Aufbewahrungsfristen (Werte aus `.env`, Logrotate, Backups)
- [ ] Zuständige Datenschutz-Aufsichtsbehörde (Beschwerderecht)
- [ ] Ob Nutzungsbedingungen gewünscht sind (z. B. Verfügbarkeit, zulässige Nutzung). Es gibt keine Vorlage, weil
      deren Inhalt eine Entscheidung des Betreibers ist.

## Fakten für die Datenschutzerklärung (aus dem Code, Stand 2.1)

Siehe [PRIVACY.md](PRIVACY.md): gespeicherte Datenkategorien, Zwecke, Löschfristen, Protokolle (Nginx speichert
IP-Adressen), Cookies (nur notwendiges Admin-Cookie), keine Drittanbieter, Rechte über Export und Kontolöschung.
