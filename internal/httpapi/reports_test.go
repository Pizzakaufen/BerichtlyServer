package httpapi_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func daily(date, text, status string) map[string]any {
	return map[string]any{"date": date, "text": text, "note": "", "orderIndex": 0, "status": status}
}

func with(m map[string]any, kv ...any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i].(string)] = kv[i+1]
	}
	return out
}

func TestTagesberichtErstellenAbrufenAendernLoeschen(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access

	created := e.post("/api/v1/daily-reports", tok, daily("2026-10-05", "Kundenauftrag bearbeitet", "DRAFT")).expect(201)
	id := created.str("data", "id")
	if created.num("data", "version") != 1 || created.str("data", "date") != "2026-10-05" ||
		!strings.HasSuffix(created.str("data", "createdAt"), "Z") {
		t.Fatal(created.Raw)
	}
	if r := e.get("/api/v1/daily-reports/"+id, tok).expect(200); r.str("data", "text") != "Kundenauftrag bearbeitet" {
		t.Fatal(r.Raw)
	}

	upd := e.put("/api/v1/daily-reports/"+id, tok, with(daily("2026-10-05", "Kundenauftrag abgeschlossen", "EDITED"), "version", 1)).expect(200)
	if upd.num("data", "version") != 2 || upd.str("data", "status") != "EDITED" {
		t.Fatal(upd.Raw)
	}

	// Veraltete Version → Konflikt, nichts wird überschrieben.
	stale := e.put("/api/v1/daily-reports/"+id, tok, with(daily("2026-10-05", "Anderer Text", "DRAFT"), "version", 1)).expect(409)
	if stale.str("error", "conflict", "reason") != "VERSION_MISMATCH" || stale.num("error", "conflict", "serverVersion") != 2 ||
		stale.str("error", "conflict", "serverRecord", "text") != "Kundenauftrag abgeschlossen" {
		t.Fatal(stale.Raw)
	}
	if e.get("/api/v1/daily-reports/"+id, tok).str("data", "text") != "Kundenauftrag abgeschlossen" {
		t.Fatal("Daten wurden überschrieben")
	}

	e.delete("/api/v1/daily-reports/"+id, tok).expect(400)              // Version fehlt
	e.delete("/api/v1/daily-reports/"+id+"?version=1", tok).expect(409) // veraltet
	e.delete("/api/v1/daily-reports/"+id+"?version=2", tok).expect(204)
	e.get("/api/v1/daily-reports/"+id, tok).expect(404)
	e.delete("/api/v1/daily-reports/"+id+"?version=2", tok).expect(204) // idempotent
	revive := e.put("/api/v1/daily-reports/"+id, tok, with(daily("2026-10-05", "Neu", "DRAFT"), "version", 3)).expect(409)
	if revive.str("error", "conflict", "reason") != "DELETED_ON_SERVER" {
		t.Fatal(revive.Raw)
	}
}

func TestErstellenMitClientIDIstIdempotent(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	id := uuid.NewString()
	body := with(daily("2026-10-06", "Netzwerk konfiguriert", "DRAFT"), "id", id)
	e.post("/api/v1/daily-reports", tok, body).expect(201)
	if r := e.post("/api/v1/daily-reports", tok, body).expect(200); r.num("data", "version") != 1 {
		t.Fatal(r.Raw)
	}
	other := e.post("/api/v1/daily-reports", tok, with(daily("2026-10-06", "Anderer Inhalt", "DRAFT"), "id", id)).expect(409)
	if other.str("error", "conflict", "reason") != "ALREADY_EXISTS" {
		t.Fatal(other.Raw)
	}
	if e.get("/api/v1/daily-reports", tok).num("meta", "total") != 1 {
		t.Fatal("Duplikat entstanden")
	}
}

func texts(r *response) []string {
	var out []string
	for _, it := range r.list("data") {
		out = append(out, field(it, "text").(string))
	}
	return out
}

func TestListeMitFilternSortierungUndPagination(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	e.post("/api/v1/daily-reports", tok, daily("2026-09-28", "A", "FINALIZED")).expect(201)
	e.post("/api/v1/daily-reports", tok, daily("2026-09-30", "B", "DRAFT")).expect(201)
	e.post("/api/v1/daily-reports", tok, daily("2026-10-02", "C", "EDITED")).expect(201)
	e.post("/api/v1/daily-reports", tok, daily("2026-10-07", "D", "DRAFT")).expect(201)

	check := func(query string, want ...string) {
		t.Helper()
		got := texts(e.get("/api/v1/daily-reports?"+query, tok).expect(200))
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("%s: %v erwartet, %v erhalten", query, want, got)
		}
	}
	check("from=2026-09-29&to=2026-10-02&sort=date_asc", "B", "C")
	check("status=DRAFT,FINALIZED", "D", "B", "A")
	check("date=2026-10-07", "D")
	check("limit=3&page=2", "A")

	p1 := e.get("/api/v1/daily-reports?limit=3&page=1", tok)
	if len(p1.list("data")) != 3 || p1.at("meta", "hasMore") != true || p1.num("meta", "total") != 4 {
		t.Fatal(p1.Raw)
	}
	for _, bad := range []string{"limit=0", "limit=1000", "page=0", "status=UNKNOWN", "from=2026-13-01",
		"sort=random", "from=2026-10-05&to=2026-10-01"} {
		if r := e.get("/api/v1/daily-reports?"+bad, tok).expect(400); r.code() != "INVALID_PARAMETER" {
			t.Fatal(bad, r.Raw)
		}
	}
}

func TestUngueltigeBerichtsdaten(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	cases := []struct {
		body  map[string]any
		field string
	}{
		{map[string]any{"date": "2026-10-05"}, "text"},
		{daily("05.10.2026", "x", "DRAFT"), "date"},
		{daily("1999-12-31", "x", "DRAFT"), "date"},
		{daily("2026-10-05", "x", "DONE"), "status"},
		{daily("2026-10-05", "   ", "DRAFT"), "text"},
		{daily("2026-10-05", strings.Repeat("ä", 5001), "DRAFT"), "text"},
		{daily("2026-10-05", "Null\u0000Byte", "DRAFT"), "text"},
		{with(daily("2026-10-05", "x", "DRAFT"), "id", "keine-uuid"), "id"},
		{with(daily("2026-10-05", "x", "DRAFT"), "orderIndex", -1), "orderIndex"},
	}
	for _, c := range cases {
		r := e.post("/api/v1/daily-reports", tok, c.body).expect(422)
		if !contains(fields(r.at("error", "details")), c.field) {
			t.Fatalf("Fehler für %s erwartet: %s", c.field, r.Raw)
		}
	}
	// 5000 Umlaute sind erlaubt (Zeichen, nicht Bytes)
	e.post("/api/v1/daily-reports", tok, daily("2026-10-05", strings.Repeat("ä", 5000), "DRAFT")).expect(201)
	e.get("/api/v1/daily-reports/123", tok).expect(400)
	e.get("/api/v1/daily-reports/"+uuid.NewString(), tok).expect(404)
}

func TestWochenuebersichtMontagBisSonntag(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	for _, d := range []string{"2026-10-04", "2026-10-05", "2026-10-08", "2026-10-11", "2026-10-12"} {
		e.post("/api/v1/daily-reports", tok, daily(d, "Tätigkeit "+d, "DRAFT")).expect(201)
	}
	e.post("/api/v1/weekly-reports", tok, map[string]any{"weekStart": "2026-10-05", "content": "KW 41"}).expect(201)

	w := e.get("/api/v1/weeks/2026-10-11", tok).expect(200) // Sonntag
	if w.str("data", "weekStart") != "2026-10-05" || w.str("data", "weekEnd") != "2026-10-11" || w.num("data", "isoWeek") != 41 {
		t.Fatal(w.Raw)
	}
	days := w.list("data", "days")
	if len(days) != 7 || field(days[0], "dayOfWeek") != "MONDAY" || field(days[6], "dayOfWeek") != "SUNDAY" {
		t.Fatal(w.Raw)
	}
	var got []string
	for _, d := range days {
		for _, r := range field(d, "dailyReports").([]any) {
			got = append(got, field(r, "text").(string))
		}
	}
	if strings.Join(got, "|") != "Tätigkeit 2026-10-05|Tätigkeit 2026-10-08|Tätigkeit 2026-10-11" {
		t.Fatal(got)
	}
	if w.str("data", "weeklyReport", "content") != "KW 41" {
		t.Fatal(w.Raw)
	}
	e.get("/api/v1/weeks/2026-02-30", tok).expect(400)
}

func TestIsoWocheUeberJahreswechsel(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	w := e.get("/api/v1/weeks/2027-01-01", tok).expect(200)
	if w.str("data", "weekStart") != "2026-12-28" || w.str("data", "weekEnd") != "2027-01-03" ||
		w.num("data", "isoYear") != 2026 || w.num("data", "isoWeek") != 53 {
		t.Fatal(w.Raw)
	}
}

func TestEinAktiverWochenberichtProWoche(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	first := e.post("/api/v1/weekly-reports", tok, map[string]any{
		"weekStart": "2026-10-05", "content": "Erster", "status": "GENERATED", "generatedAt": "2026-10-09T15:00:00.123Z",
	}).expect(201)
	if first.str("data", "weekEnd") != "2026-10-11" || first.str("data", "generatedAt") != "2026-10-09T15:00:00.123Z" {
		t.Fatal(first.Raw)
	}
	dup := e.post("/api/v1/weekly-reports", tok, map[string]any{"weekStart": "2026-10-05", "content": "Zweiter"}).expect(409)
	if dup.str("error", "conflict", "reason") != "DUPLICATE_WEEK" || dup.str("error", "conflict", "serverRecord", "content") != "Erster" {
		t.Fatal(dup.Raw)
	}
	e.delete("/api/v1/weekly-reports/"+first.str("data", "id")+"?version=1", tok).expect(204)
	e.post("/api/v1/weekly-reports", tok, map[string]any{"weekStart": "2026-10-05", "content": "Neu"}).expect(201)
	e.post("/api/v1/weekly-reports", tok, map[string]any{"weekStart": "2026-10-07"}).expect(422)

	list := e.get("/api/v1/weekly-reports?from=2026-10-01&to=2026-10-31", tok).expect(200)
	if len(list.list("data")) != 1 || field(list.list("data")[0], "content") != "Neu" {
		t.Fatal(list.Raw)
	}
}
