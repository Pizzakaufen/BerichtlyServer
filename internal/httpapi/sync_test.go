package httpapi_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func dailyChange(id, text string, base any, op string) map[string]any {
	c := map[string]any{"type": "DAILY_REPORT", "operation": op, "id": id, "baseVersion": base}
	if op == "UPSERT" {
		c["data"] = map[string]any{"date": "2026-10-05", "text": text}
	}
	return c
}

func push(changes ...map[string]any) map[string]any {
	list := make([]any, len(changes))
	for i, c := range changes {
		list[i] = c
	}
	return map[string]any{"changes": list}
}

func statuses(r *response) []string {
	var out []string
	for _, it := range r.list("data", "results") {
		out = append(out, field(it, "status").(string))
	}
	return out
}

func TestSyncVollstaendigerAblauf(t *testing.T) {
	e := newEnv(t)
	device := uuid.NewString()
	tok := e.register("", map[string]any{"device": map[string]any{"id": device, "name": "Pixel Test"}}).access

	initial := e.get("/api/v1/sync/changes?cursor=0", tok).expect(200)
	if ch := initial.list("data", "changes"); len(ch) != 1 || field(ch[0], "type") != "PROFILE" {
		t.Fatal(initial.Raw)
	}
	cursor0 := initial.str("data", "nextCursor")

	id := uuid.NewString()
	res := e.post("/api/v1/sync/push", tok, push(dailyChange(id, "Offline erfasst", nil, "UPSERT"))).expect(200)
	if res.str("data", "results", 0, "status") != "APPLIED" || res.num("data", "results", 0, "version") != 1 {
		t.Fatal(res.Raw)
	}
	// Wiederholung (z. B. Antwort verloren) ist idempotent.
	retry := e.post("/api/v1/sync/push", tok, push(dailyChange(id, "Offline erfasst", nil, "UPSERT")))
	if retry.str("data", "results", 0, "status") != "APPLIED" || retry.num("data", "results", 0, "version") != 1 {
		t.Fatal(retry.Raw)
	}

	pull1 := e.get("/api/v1/sync/changes?cursor="+cursor0, tok)
	if ch := pull1.list("data", "changes"); len(ch) != 1 || field(ch[0], "id") != id {
		t.Fatal(pull1.Raw)
	}
	if pull1.str("data", "changes", 0, "data", "text") != "Offline erfasst" {
		t.Fatal(pull1.Raw)
	}
	cursor1 := pull1.str("data", "nextCursor")

	// Änderung auf dem Server (anderes Gerät) erscheint im nächsten Pull.
	e.put("/api/v1/daily-reports/"+id, tok, map[string]any{"version": 1, "date": "2026-10-05", "text": "Auf Gerät 2 geändert"}).expect(200)
	pull2 := e.get("/api/v1/sync/changes?cursor="+cursor1, tok)
	if pull2.num("data", "changes", 0, "version") != 2 {
		t.Fatal(pull2.Raw)
	}

	// Konflikt: lokale Änderung basiert noch auf Version 1.
	c := e.post("/api/v1/sync/push", tok, push(dailyChange(id, "Lokal geändert", 1, "UPSERT")))
	if c.str("data", "results", 0, "status") != "CONFLICT" || c.str("data", "results", 0, "conflict", "reason") != "VERSION_MISMATCH" ||
		c.str("data", "results", 0, "conflict", "serverRecord", "text") != "Auf Gerät 2 geändert" {
		t.Fatal(c.Raw)
	}

	// Löschen → Tombstone im Pull.
	if r := e.post("/api/v1/sync/push", tok, push(dailyChange(id, "", 2, "DELETE"))); r.str("data", "results", 0, "status") != "APPLIED" {
		t.Fatal(r.Raw)
	}
	pull3 := e.get("/api/v1/sync/changes?cursor="+pull2.str("data", "nextCursor"), tok)
	if pull3.at("data", "changes", 0, "deleted") != true || pull3.at("data", "changes", 0, "data") != nil || pull3.num("data", "changes", 0, "version") != 3 {
		t.Fatal(pull3.Raw)
	}
	// Bearbeiten eines gelöschten Datensatzes → Konflikt statt Wiederherstellung.
	if r := e.post("/api/v1/sync/push", tok, push(dailyChange(id, "Noch lokal", 2, "UPSERT"))); r.str("data", "results", 0, "conflict", "reason") != "DELETED_ON_SERVER" {
		t.Fatal(r.Raw)
	}

	st := e.get("/api/v1/sync/status", tok).expect(200)
	if st.str("data", "serverCursor") != pull3.str("data", "nextCursor") || st.str("data", "device", "deviceId") != device ||
		st.str("data", "device", "lastPullCursor") != pull3.str("data", "nextCursor") || st.at("data", "device", "lastPushAt") == nil {
		t.Fatal(st.Raw)
	}
}

func TestSyncPushVerarbeitetElementeEinzeln(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	good := uuid.NewString()
	r := e.post("/api/v1/sync/push", tok, push(
		dailyChange(good, "Gültig", nil, "UPSERT"),
		map[string]any{"type": "DAILY_REPORT", "operation": "UPSERT", "id": "keine-uuid"},
		dailyChange(uuid.NewString(), "", nil, "UPSERT"),
		map[string]any{"type": "UNKNOWN", "operation": "UPSERT", "id": uuid.NewString()},
		dailyChange(uuid.NewString(), "Unbekannt", 4, "UPSERT"),
		map[string]any{"type": "DAILY_REPORT", "operation": "UPSERT", "id": uuid.NewString(),
			"data": map[string]any{"date": "2026-10-05", "text": "x", "orderIndex": "abc"}},
	)).expect(200)
	if got := strings.Join(statuses(r), ","); got != "APPLIED,REJECTED,REJECTED,REJECTED,REJECTED,REJECTED" {
		t.Fatal(got, r.Raw)
	}
	if r.str("data", "results", 1, "error", "code") != "VALIDATION_FAILED" || r.str("data", "results", 4, "error", "code") != "NOT_FOUND" ||
		r.str("data", "results", 5, "error", "code") != "INVALID_REQUEST_BODY" {
		t.Fatal(r.Raw)
	}
	e.get("/api/v1/daily-reports/"+good, tok).expect(200)

	var many []map[string]any
	for i := 0; i < 101; i++ {
		many = append(many, dailyChange(uuid.NewString(), "x", nil, "UPSERT"))
	}
	e.post("/api/v1/sync/push", tok, push(many...)).expect(422)
}

func TestSyncPullPaginationUeberCursor(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access
	var changes []map[string]any
	ids := map[string]bool{}
	for i := 0; i < 5; i++ {
		id := uuid.NewString()
		ids[id] = true
		changes = append(changes, dailyChange(id, "Bericht", nil, "UPSERT"))
	}
	e.post("/api/v1/sync/push", tok, push(changes...)).expect(200)

	seen := map[string]bool{}
	cursor, rounds := "0", 0
	for {
		p := e.get("/api/v1/sync/changes?limit=2&cursor="+cursor, tok).expect(200)
		for _, c := range p.list("data", "changes") {
			id := field(c, "id").(string)
			if seen[id] {
				t.Fatal("doppelte Änderung", id)
			}
			seen[id] = true
		}
		cursor, rounds = p.str("data", "nextCursor"), rounds+1
		if p.at("data", "hasMore") != true || rounds > 10 {
			break
		}
	}
	if rounds != 3 { // 1 Profil + 5 Berichte = 6 Änderungen à 2
		t.Fatalf("%d Runden", rounds)
	}
	for id := range ids {
		if !seen[id] {
			t.Fatal("Änderung fehlt", id)
		}
	}
	e.get("/api/v1/sync/changes?cursor=-1", tok).expect(400)
	e.get("/api/v1/sync/changes?cursor=abc", tok).expect(400)
}

func TestSyncProfilUndWochenberichte(t *testing.T) {
	e := newEnv(t)
	s := e.register("")
	weekly := uuid.NewString()
	r := e.post("/api/v1/sync/push", s.access, push(
		map[string]any{"type": "PROFILE", "operation": "UPSERT", "id": s.userID, "baseVersion": 1,
			"data": map[string]any{"name": "Max Muster", "profession": "Fachinformatiker"}},
		map[string]any{"type": "WEEKLY_REPORT", "operation": "UPSERT", "id": weekly,
			"data": map[string]any{"weekStart": "2026-10-05", "content": "Woche"}},
		map[string]any{"type": "PROFILE", "operation": "DELETE", "id": s.userID, "baseVersion": 2},
	)).expect(200)
	if got := strings.Join(statuses(r), ","); got != "APPLIED,APPLIED,REJECTED" {
		t.Fatal(got, r.Raw)
	}
	if e.get("/api/v1/profile", s.access).str("data", "name") != "Max Muster" {
		t.Fatal("Profil nicht übernommen")
	}
	types := map[string]bool{}
	for _, c := range e.get("/api/v1/sync/changes?cursor=0", s.access).list("data", "changes") {
		types[field(c, "type").(string)] = true
	}
	if !types["PROFILE"] || !types["WEEKLY_REPORT"] || len(types) != 2 {
		t.Fatal(types)
	}
}

func TestAktuelleWocheInBenutzerzeitzone(t *testing.T) {
	// Sonntag, 4.10.2026, 23:30 UTC = Montag 01:30 in Berlin, aber noch Sonntag in New York.
	fixed := time.Date(2026, 10, 4, 23, 30, 0, 0, time.UTC)
	e := newEnv(t)
	berlin := e.register("", map[string]any{"timezone": "Europe/Berlin"})
	newYork := e.register("", map[string]any{"timezone": "America/New_York"})
	if r := e.get("/api/v1/weeks/current", berlin.access).expect(200); r.str("data", "timezone") != "Europe/Berlin" {
		t.Fatal(r.Raw)
	}
	e.app.Reports.Now = func() time.Time { return fixed }
	for _, c := range []struct {
		userID, want string
	}{{berlin.userID, "2026-10-05"}, {newYork.userID, "2026-09-28"}} {
		ov, err := e.app.Reports.Week(context.Background(), uuid.MustParse(c.userID), nil)
		if err != nil {
			t.Fatal(err)
		}
		if ov.Week.Start.String() != c.want {
			t.Fatalf("Woche %s erwartet, %s erhalten", c.want, ov.Week.Start)
		}
	}
}
