package httpapi_test

import (
	"strings"
	"testing"
)

// Benutzer A darf niemals Daten von Benutzer B sehen oder verändern – und umgekehrt.
func TestBenutzerBKannDatenVonAWederLesenNochAendern(t *testing.T) {
	e := newEnv(t)
	a := e.register("a@example.org")
	b := e.register("b@example.org")

	dailyID := e.post("/api/v1/daily-reports", a.access, map[string]any{"date": "2026-10-05", "text": "Geheimer Bericht von A"}).expect(201).str("data", "id")
	weeklyID := e.post("/api/v1/weekly-reports", a.access, map[string]any{"weekStart": "2026-10-05", "content": "Wochenbericht von A"}).expect(201).str("data", "id")

	// Lesen
	e.get("/api/v1/daily-reports/"+dailyID, b.access).expect(404)
	e.get("/api/v1/weekly-reports/"+weeklyID, b.access).expect(404)
	for _, path := range []string{"/api/v1/daily-reports", "/api/v1/weekly-reports", "/api/v1/weeks/2026-10-05", "/api/v1/sync/changes?cursor=0"} {
		raw := e.get(path, b.access).expect(200).Raw
		if strings.Contains(raw, "von A") || strings.Contains(raw, dailyID) || strings.Contains(raw, a.userID) {
			t.Fatalf("%s enthält fremde Daten: %s", path, raw)
		}
	}

	// Ändern und Löschen
	e.put("/api/v1/daily-reports/"+dailyID, b.access, map[string]any{"version": 1, "date": "2026-10-05", "text": "Von B"}).expect(404)
	e.put("/api/v1/weekly-reports/"+weeklyID, b.access, map[string]any{"version": 1, "weekStart": "2026-10-05", "content": "Von B"}).expect(404)
	e.delete("/api/v1/daily-reports/"+dailyID+"?version=1", b.access).expect(404)
	e.delete("/api/v1/weekly-reports/"+weeklyID+"?version=1", b.access).expect(404)

	// Erstellen mit der ID eines fremden Berichts verrät dessen Inhalt nicht.
	hijack := e.post("/api/v1/daily-reports", b.access, map[string]any{"id": dailyID, "date": "2026-10-05", "text": "B"}).expect(409)
	if hijack.str("error", "conflict", "reason") != "ID_UNAVAILABLE" || hijack.at("error", "conflict", "serverRecord") != nil ||
		strings.Contains(hijack.Raw, "Geheimer") {
		t.Fatal(hijack.Raw)
	}

	// Sync: Push auf fremde IDs wird abgelehnt.
	r := e.post("/api/v1/sync/push", b.access, push(
		map[string]any{"type": "DAILY_REPORT", "operation": "UPSERT", "id": dailyID, "baseVersion": 1,
			"data": map[string]any{"date": "2026-10-05", "text": "B"}},
		map[string]any{"type": "DAILY_REPORT", "operation": "DELETE", "id": dailyID, "baseVersion": 1},
		map[string]any{"type": "PROFILE", "operation": "UPSERT", "id": a.userID, "baseVersion": 1,
			"data": map[string]any{"name": "Gekapert"}},
	)).expect(200)
	if got := strings.Join(statuses(r), ","); got != "REJECTED,REJECTED,REJECTED" {
		t.Fatal(got, r.Raw)
	}

	// A sieht seine Daten unverändert.
	if e.get("/api/v1/daily-reports/"+dailyID, a.access).str("data", "text") != "Geheimer Bericht von A" {
		t.Fatal("Daten von A verändert")
	}
	if e.get("/api/v1/profile", a.access).str("data", "name") != "" {
		t.Fatal("Profil von A verändert")
	}
}

func TestProfilUndGeraeteNurFuerEigenenBenutzer(t *testing.T) {
	e := newEnv(t)
	device := "11111111-1111-4111-8111-111111111111"
	a := e.register("", map[string]any{"device": map[string]any{"id": device, "name": "Pixel A"}})
	b := e.register("")
	e.put("/api/v1/profile", a.access, map[string]any{"version": 1, "name": "Anna A"}).expect(200)
	if e.get("/api/v1/profile", b.access).str("data", "name") != "" {
		t.Fatal("fremdes Profil sichtbar")
	}
	if len(e.get("/api/v1/devices", b.access).list("data")) != 0 {
		t.Fatal("fremde Geräte sichtbar")
	}
	e.delete("/api/v1/devices/"+device, b.access).expect(404)
	devs := e.get("/api/v1/devices", a.access).expect(200)
	if devs.str("data", 0, "id") != device || devs.at("data", 0, "current") != true {
		t.Fatal(devs.Raw)
	}
	// Gerät abmelden beendet dessen Sitzungen.
	e.delete("/api/v1/devices/"+device, a.access).expect(204)
	e.get("/api/v1/profile", a.access).expect(401)
}

func TestProfilAktualisierenMitVersionspruefung(t *testing.T) {
	e := newEnv(t)
	s := e.register("")
	p := e.get("/api/v1/profile", s.access).expect(200)
	if p.str("data", "id") != s.userID || p.str("data", "name") != "" || p.at("data", "trainingStart") != nil ||
		p.str("data", "writingStyle") != "NEUTRAL" || p.num("data", "version") != 1 {
		t.Fatal("neues Profil enthält erfundene Daten:", p.Raw)
	}
	body := map[string]any{"version": 1, "name": "  Max Muster ", "profession": "Fachinformatiker für Anwendungsentwicklung",
		"company": "Muster GmbH", "department": "IT", "trainerName": "Erika Beispiel",
		"trainingStart": "2025-08-01", "trainingEnd": "2028-07-31", "writingStyle": "FORMAL"}
	u := e.put("/api/v1/profile", s.access, body).expect(200)
	if u.str("data", "name") != "Max Muster" || u.num("data", "version") != 2 || u.str("data", "trainingEnd") != "2028-07-31" {
		t.Fatal(u.Raw)
	}
	if e.put("/api/v1/profile", s.access, body).num("data", "version") != 2 {
		t.Fatal("identische Wiederholung erzeugt neue Version")
	}
	stale := e.put("/api/v1/profile", s.access, map[string]any{"version": 1, "name": "Anders"}).expect(409)
	if stale.str("error", "conflict", "serverRecord", "name") != "Max Muster" {
		t.Fatal(stale.Raw)
	}
	for _, bad := range []map[string]any{
		{"name": "x"},
		{"version": 1, "name": "Zeile1\nZeile2"},
		{"version": 1, "company": strings.Repeat("a", 161)},
		{"version": 1, "trainingStart": "2026-08-01", "trainingEnd": "2025-08-01"},
		{"version": 1, "trainingStart": "irgendwann"},
		{"version": 1, "writingStyle": "LOCKER"},
	} {
		e.put("/api/v1/profile", s.access, bad).expect(422)
	}
}
