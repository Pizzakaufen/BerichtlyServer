package httpapi_test

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Sommer-/Winterzeit, Jahres- und Wochenwechsel in Europe/Berlin.
func TestAktuelleWocheUmSommerUndWinterzeitwechsel(t *testing.T) {
	e := newEnv(t)
	s := e.register("", map[string]any{"timezone": "Europe/Berlin"})
	ny := e.register("", map[string]any{"timezone": "America/New_York"})
	cases := []struct {
		utc, berlinWeek, berlinToday string
	}{
		// Umstellung auf Sommerzeit: So 29.03.2026, 02:00 → 03:00. 22:30 UTC am Sonntag = Mo 00:30 MESZ.
		{"2026-03-29T22:30:00Z", "2026-03-30", "2026-03-30"},
		{"2026-03-29T21:59:00Z", "2026-03-23", "2026-03-29"}, // So 23:59 MESZ
		// Umstellung auf Winterzeit: So 25.10.2026, 03:00 → 02:00. 23:00 UTC am Sonntag = Mo 00:00 MEZ.
		{"2026-10-25T23:00:00Z", "2026-10-26", "2026-10-26"},
		{"2026-10-25T22:59:59Z", "2026-10-19", "2026-10-25"},
		// Jahreswechsel: Silvester 23:30 UTC = Neujahr 00:30 MEZ; Do 01.01.2026 liegt in KW 1 ab 29.12.2025.
		{"2025-12-31T23:30:00Z", "2025-12-29", "2026-01-01"},
	}
	for _, c := range cases {
		now, _ := time.Parse(time.RFC3339, c.utc)
		e.app.Reports.Now = func() time.Time { return now }
		w := e.get("/api/v1/weeks/current", s.access).expect(200)
		if w.str("data", "weekStart") != c.berlinWeek || w.str("data", "today") != c.berlinToday {
			t.Fatalf("%s: Woche %s/heute %s erwartet, erhalten %s/%s", c.utc, c.berlinWeek, c.berlinToday,
				w.str("data", "weekStart"), w.str("data", "today"))
		}
	}
	// Dieselbe Uhrzeit liegt in New York noch am Sonntag der Vorwoche.
	now, _ := time.Parse(time.RFC3339, "2026-03-29T22:30:00Z")
	e.app.Reports.Now = func() time.Time { return now }
	if w := e.get("/api/v1/weeks/current", ny.access); w.str("data", "weekStart") != "2026-03-23" {
		t.Fatal(w.Raw)
	}
}

func TestWocheNachIsoNummerUndFilterNachMonatJahrWoche(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	for _, d := range []string{"2025-12-31", "2026-01-01", "2026-01-04", "2026-01-05", "2026-02-28", "2026-03-01"} {
		e.post("/api/v1/daily-reports", tok, daily(d, "T "+d, "DRAFT")).expect(201)
	}
	w := e.get("/api/v1/weeks/2026/1", tok).expect(200)
	if w.str("data", "weekStart") != "2025-12-29" || w.str("data", "weekEnd") != "2026-01-04" {
		t.Fatal(w.Raw)
	}
	// 2026 beginnt an einem Donnerstag und hat daher 53 ISO-Wochen, 2025 nur 52.
	if w53 := e.get("/api/v1/weeks/2026/53", tok).expect(200); w53.str("data", "weekStart") != "2026-12-28" {
		t.Fatal(w53.Raw)
	}
	e.get("/api/v1/weeks/2025/53", tok).expect(400)
	e.get("/api/v1/weeks/2026/0", tok).expect(400)
	e.get("/api/v1/weeks/abc/1", tok).expect(400)
	e.get("/api/v1/weeks/2020/53", tok).expect(200) // 2020 hatte 53 ISO-Wochen

	check := func(query string, want ...string) {
		t.Helper()
		got := texts(e.get("/api/v1/daily-reports?sort=date_asc&"+query, tok).expect(200))
		if strings.Join(got, "|") != strings.Join(want, "|") {
			t.Fatalf("%s: %v erwartet, %v erhalten", query, want, got)
		}
	}
	check("isoYear=2026&isoWeek=1", "T 2025-12-31", "T 2026-01-01", "T 2026-01-04")
	check("year=2026&month=2", "T 2026-02-28")
	check("year=2025", "T 2025-12-31")
	check("year=2026&isoYear=2026&isoWeek=1", "T 2026-01-01", "T 2026-01-04") // Schnittmenge
	check("year=2026&month=3&from=2026-03-02")                                // leere Schnittmenge
	for _, bad := range []string{"month=2", "year=1999", "year=2026&month=13", "isoYear=2026", "isoYear=2026&isoWeek=60"} {
		e.get("/api/v1/daily-reports?"+bad, tok).expect(400)
	}
}

// IDOR-Szenarien: manipulierte Benutzer-, Bericht- und Geräte-IDs dürfen nie zu fremden Daten führen.
func TestManipulierteIDsUndServerfelderWerdenIgnoriert(t *testing.T) {
	e := newEnv(t)
	a := e.register("")
	b := e.register("")

	// Vom Client gesendete userId/version/createdAt usw. werden ignoriert bzw. servergeneriert.
	r := e.post("/api/v1/daily-reports", b.access, map[string]any{
		"date": "2026-10-05", "text": "B schreibt", "userId": a.userID, "user_id": a.userID,
		"version": 99, "createdAt": "2000-01-01T00:00:00.000Z", "updatedAt": "2000-01-01T00:00:00.000Z",
		"deleted": true, "changeSeq": 1, "createdByDeviceId": uuid.NewString(),
	}).expect(201)
	if r.num("data", "version") != 1 || strings.HasPrefix(r.str("data", "createdAt"), "2000") || r.at("data", "deleted") != false ||
		r.at("data", "createdByDeviceId") != nil {
		t.Fatal(r.Raw)
	}
	if e.get("/api/v1/daily-reports", a.access).num("meta", "total") != 0 {
		t.Fatal("Bericht landete bei fremdem Benutzer")
	}
	e.put("/api/v1/profile", b.access, map[string]any{"version": 1, "name": "B", "userId": a.userID, "id": a.userID}).expect(200)
	if e.get("/api/v1/profile", a.access).str("data", "name") != "" {
		t.Fatal("fremdes Profil verändert")
	}
	// Sync mit fremder Profil-ID wird abgelehnt.
	res := e.post("/api/v1/sync", b.access, map[string]any{"changes": []any{map[string]any{
		"operationId": uuid.NewString(), "type": "PROFILE", "operation": "UPSERT", "id": a.userID, "baseVersion": 1,
		"data": map[string]any{"name": "Gekapert"}}}}).expect(200)
	if res.str("data", "push", "results", 0, "status") != "REJECTED" {
		t.Fatal(res.Raw)
	}
}

func TestReadinessUndSicherheitsHeader(t *testing.T) {
	e := newEnv(t)
	r := e.get("/api/v1/health/ready", "").expect(200)
	if r.str("data", "status") != "ready" || r.str("data", "components", "schema") != "current" {
		t.Fatal(r.Raw)
	}
	if !strings.Contains(r.Header.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatal(r.Header)
	}
	if r.Header.Get("Strict-Transport-Security") != "" {
		t.Fatal("HSTS ohne HTTPS-Proxy gesetzt")
	}
	p := newEnv(t, opts{overrides: map[string]string{"TRUST_PROXY": "true"}})
	h := p.get("/api/v1/health", "", "X-Forwarded-Proto", "https")
	if h.Header.Get("Strict-Transport-Security") == "" {
		t.Fatal("HSTS hinter HTTPS-Proxy fehlt")
	}
	// Ohne TRUST_PROXY wird X-Forwarded-Proto ignoriert.
	if e.get("/api/v1/health", "", "X-Forwarded-Proto", "https").Header.Get("Strict-Transport-Security") != "" {
		t.Fatal("X-Forwarded-Proto ohne TRUST_PROXY vertraut")
	}
}

func TestWartungBeachtetAufbewahrungsfristen(t *testing.T) {
	e := newEnv(t)
	d := e.newDevice("wartung@example.org", true)
	recent, old := uuid.NewString(), uuid.NewString()
	d.sync(op(uuid.NewString(), recent, nil, "UPSERT", "a"), op(uuid.NewString(), old, nil, "UPSERT", "b"))
	d.sync(op(uuid.NewString(), recent, 1, "DELETE", ""), op(uuid.NewString(), old, 1, "DELETE", ""))
	ctx := t.Context()
	pool := e.app.DB.Pool
	mustExec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	ageRow(t, e, "daily_reports", "deleted_at", "364 days", recent)
	ageRow(t, e, "daily_reports", "deleted_at", "366 days", old)
	mustExec(`UPDATE sync_operations SET created_at = now() - interval '31 days' WHERE entity_id = $1`, old)
	mustExec(`UPDATE security_events SET created_at = now() - interval '181 days' WHERE id = (SELECT min(id) FROM security_events)`)

	res, err := e.app.RunMaintenance(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if res.TombstonesPurged != 1 || res.OperationsPurged != 2 || res.SecurityEventsPurged != 1 {
		t.Fatalf("%+v", res)
	}
	var n int
	_ = pool.QueryRow(ctx, `SELECT count(*) FROM daily_reports WHERE id = $1`, recent).Scan(&n)
	if n != 1 {
		t.Fatal("Tombstone innerhalb der Frist gelöscht")
	}
	// Aktive Berichte werden nie von der Wartung angetastet.
	keep := uuid.NewString()
	d.sync(op(uuid.NewString(), keep, nil, "UPSERT", "aktiv"))
	ageRow(t, e, "daily_reports", "created_at", "10 years", keep)
	if _, err := e.app.RunMaintenance(ctx); err != nil {
		t.Fatal(err)
	}
	e.get("/api/v1/daily-reports/"+keep, d.s.access).expect(200)
}
