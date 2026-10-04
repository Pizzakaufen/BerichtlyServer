package httpapi_test

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// device simuliert ein Android-Gerät mit lokaler Datenbank (nur so weit, wie für die Tests nötig).
type device struct {
	e      *env
	s      session
	id     string
	cursor string
	// lokaler Stand: Bericht-ID -> (Version, Text, gelöscht)
	local map[string]*localReport
}

type localReport struct {
	version int
	text    string
	deleted bool
}

func (e *env) newDevice(email string, register bool) *device {
	id := uuid.NewString()
	var s session
	if register {
		s = e.register(email, map[string]any{"device": map[string]any{"id": id, "name": "Gerät " + id[:4]}})
	} else {
		s = e.loginDevice(email, id, "Gerät "+id[:4])
	}
	return &device{e: e, s: s, id: id, cursor: "0", local: map[string]*localReport{}}
}

func op(opID, id string, base any, kind, text string) map[string]any {
	c := map[string]any{"operationId": opID, "type": "DAILY_REPORT", "operation": kind, "id": id, "baseVersion": base,
		"clientUpdatedAt": "2026-10-05T07:00:00.000Z"}
	if kind == "UPSERT" {
		c["data"] = map[string]any{"date": "2026-10-05", "text": text}
	}
	return c
}

// sync führt einen vollständigen Synchronisationsvorgang aus (mit Pagination) und meldet den Abschluss.
func (d *device) sync(changes ...map[string]any) *response {
	d.e.t.Helper()
	list := make([]any, len(changes))
	for i, c := range changes {
		list[i] = c
	}
	first := d.e.post("/api/v1/sync", d.s.access, map[string]any{"cursor": d.cursor, "limit": 50, "changes": list}).expect(200)
	d.apply(first, "pull")
	for more := first.at("data", "pull", "hasMore") == true; more; {
		page := d.e.get("/api/v1/sync/changes?limit=50&cursor="+d.cursor, d.s.access).expect(200)
		d.apply(page, "")
		more = page.at("data", "hasMore") == true
	}
	d.e.post("/api/v1/sync/complete", d.s.access, map[string]any{"result": "SUCCESS", "cursor": d.cursor}).expect(200)
	return first
}

func (d *device) apply(r *response, prefix string) {
	path := []any{"data"}
	if prefix != "" {
		path = append(path, prefix)
	}
	for _, c := range r.list(append(path, "changes")...) {
		if field(c, "type") != "DAILY_REPORT" {
			continue
		}
		id := field(c, "id").(string)
		lr := &localReport{version: int(field(c, "version").(float64)), deleted: field(c, "deleted") == true}
		if !lr.deleted {
			lr.text = field(field(c, "data"), "text").(string)
		}
		d.local[id] = lr
	}
	d.cursor = r.str(append(path, "nextCursor")...)
}

func (d *device) active() map[string]string {
	out := map[string]string{}
	for id, r := range d.local {
		if !r.deleted {
			out[id] = r.text
		}
	}
	return out
}

func serverCount(e *env, token string) int {
	return e.get("/api/v1/daily-reports?limit=1", token).num("meta", "total")
}

func TestSyncSzenarioNeuesGeraetMitBestehendemBerichtsheft(t *testing.T) {
	e := newEnv(t)
	email := "heft@example.org"
	phone := e.newDevice(email, true)

	// Bestehendes Berichtsheft: 250 lokale Berichte in Paketen zu je 100 hochladen.
	var ops []map[string]any
	for i := 0; i < 250; i++ {
		ops = append(ops, op(uuid.NewString(), uuid.NewString(), nil, "UPSERT", fmt.Sprintf("Bericht %03d", i)))
	}
	for start := 0; start < len(ops); start += 100 {
		end := min(start+100, len(ops))
		r := phone.sync(ops[start:end]...)
		for _, res := range r.list("data", "push", "results") {
			if field(res, "status") != "APPLIED" {
				t.Fatal(r.Raw)
			}
		}
	}
	if serverCount(e, phone.s.access) != 250 {
		t.Fatal("nicht alle Berichte auf dem Server")
	}

	// Neues Tablet mit leerer lokaler Datenbank: vollständiger Abruf über mehrere Seiten.
	tablet := e.newDevice(email, false)
	tablet.sync()
	if got := len(tablet.active()); got != 250 {
		t.Fatalf("Tablet hat %d statt 250 Berichte", got)
	}
	st := e.get("/api/v1/sync/status", tablet.s.access)
	if st.str("data", "device", "syncStatus") != "SUCCESS" || st.str("data", "device", "lastSuccessfulCursor") != tablet.cursor ||
		st.at("data", "device", "lastSyncAt") == nil {
		t.Fatal(st.Raw)
	}
}

func TestSyncSzenarioAenderungenAufMehrerenGeraetenUndLoeschung(t *testing.T) {
	e := newEnv(t)
	email := "multi@example.org"
	a := e.newDevice(email, true)
	b := e.newDevice(email, false)

	r1, r2 := uuid.NewString(), uuid.NewString()
	a.sync(op(uuid.NewString(), r1, nil, "UPSERT", "von A"))
	b.sync(op(uuid.NewString(), r2, nil, "UPSERT", "von B"))
	a.sync()
	if len(a.active()) != 2 || len(b.active()) != 2 {
		t.Fatalf("A=%v B=%v", a.active(), b.active())
	}

	// B ändert r1, A löscht r2 – unabhängige Änderungen, keine Konflikte.
	b.sync(op(uuid.NewString(), r1, b.local[r1].version, "UPSERT", "von A, ergänzt von B"))
	a.sync(op(uuid.NewString(), r2, a.local[r2].version, "DELETE", ""))
	b.sync()
	a.sync()
	for name, d := range map[string]*device{"A": a, "B": b} {
		act := d.active()
		if len(act) != 1 || act[r1] != "von A, ergänzt von B" {
			t.Fatalf("Gerät %s: %v", name, act)
		}
		if !d.local[r2].deleted {
			t.Fatalf("Gerät %s kennt die Löschung nicht", name)
		}
	}
	if serverCount(e, a.s.access) != 1 {
		t.Fatal("Serverzustand falsch")
	}
}

func TestSyncSzenarioEchterKonfliktZwischenZweiGeraeten(t *testing.T) {
	e := newEnv(t)
	email := "konflikt@example.org"
	a := e.newDevice(email, true)
	b := e.newDevice(email, false)
	id := uuid.NewString()
	a.sync(op(uuid.NewString(), id, nil, "UPSERT", "Original"))
	b.sync()

	// Beide Geräte ändern denselben Bericht offline auf Basis von Version 1.
	a.sync(op(uuid.NewString(), id, 1, "UPSERT", "Fassung A"))
	r := e.post("/api/v1/sync", b.s.access, map[string]any{"cursor": b.cursor,
		"changes": []any{op(uuid.NewString(), id, 1, "UPSERT", "Fassung B")}}).expect(200)
	res := r.at("data", "push", "results", 0)
	if field(res, "status") != "CONFLICT" {
		t.Fatal(r.Raw)
	}
	conflict := field(res, "conflict")
	if field(conflict, "reason") != "VERSION_MISMATCH" || field(field(conflict, "serverRecord"), "text") != "Fassung A" {
		t.Fatal(r.Raw)
	}
	// Keine stille Überschreibung: Server hat weiterhin Fassung A.
	if e.get("/api/v1/daily-reports/"+id, a.s.access).str("data", "text") != "Fassung A" {
		t.Fatal("Konflikt hat Daten überschrieben")
	}
	// B meldet einen Abschluss mit ungelöstem Konflikt → Status CONFLICT.
	done := e.post("/api/v1/sync/complete", b.s.access, map[string]any{"result": "SUCCESS",
		"cursor": r.str("data", "pull", "nextCursor"), "unresolvedConflicts": 1}).expect(200)
	if done.str("data", "syncStatus") != "CONFLICT" || done.num("data", "unresolvedConflicts") != 1 {
		t.Fatal(done.Raw)
	}
	// Benutzer entscheidet sich für Fassung B: erneut senden auf Basis der Serverversion.
	resolve := e.post("/api/v1/sync", b.s.access, map[string]any{"cursor": b.cursor,
		"changes": []any{op(uuid.NewString(), id, int(field(conflict, "serverVersion").(float64)), "UPSERT", "Fassung B")}}).expect(200)
	if resolve.str("data", "push", "results", 0, "status") != "APPLIED" {
		t.Fatal(resolve.Raw)
	}
	ok := e.post("/api/v1/sync/complete", b.s.access, map[string]any{"result": "SUCCESS",
		"cursor": resolve.str("data", "pull", "nextCursor")}).expect(200)
	if ok.str("data", "syncStatus") != "SUCCESS" || ok.num("data", "unresolvedConflicts") != 0 {
		t.Fatal(ok.Raw)
	}
}

func TestSyncSzenarioWiederholteOperationUndNetzwerkabbruch(t *testing.T) {
	e := newEnv(t)
	d := e.newDevice("netz@example.org", true)
	id, createOp := uuid.NewString(), uuid.NewString()

	// 1. Push wird verarbeitet, die Antwort geht verloren (Netzwerkabbruch) …
	e.post("/api/v1/sync/push", d.s.access, map[string]any{"changes": []any{op(createOp, id, nil, "UPSERT", "Erfasst")}}).expect(200)
	// … in der Zwischenzeit ändert ein anderes Gerät den Bericht …
	other := e.newDevice("netz@example.org", false)
	other.sync()
	other.sync(op(uuid.NewString(), id, 1, "UPSERT", "Anderes Gerät"))
	// … dann wiederholt das erste Gerät exakt dieselbe Operation.
	replay := e.post("/api/v1/sync/push", d.s.access, map[string]any{"changes": []any{op(createOp, id, nil, "UPSERT", "Erfasst")}}).expect(200)
	res := replay.at("data", "results", 0)
	if field(res, "status") != "APPLIED" || field(res, "replayed") != true || field(res, "version").(float64) != 1 {
		t.Fatal("Wiederholung muss das ursprüngliche Ergebnis liefern:", replay.Raw)
	}
	if serverCount(e, d.s.access) != 1 || e.get("/api/v1/daily-reports/"+id, d.s.access).str("data", "text") != "Anderes Gerät" {
		t.Fatal("Wiederholung hat Daten verändert oder dupliziert")
	}

	// Dieselbe operationId für eine andere Änderung wird abgelehnt.
	misuse := e.post("/api/v1/sync/push", d.s.access, map[string]any{"changes": []any{op(createOp, id, nil, "UPSERT", "Etwas anderes")}})
	if misuse.str("data", "results", 0, "error", "code") != "OPERATION_ID_REUSED" {
		t.Fatal(misuse.Raw)
	}

	// 2. Abbruch während des Abrufs: Der Cursor wird erst nach lokaler Übernahme gespeichert,
	//    ein erneuter Abruf vom alten Cursor liefert dieselben Daten – nichts fehlt, nichts doppelt.
	before := d.cursor
	p1 := e.get("/api/v1/sync/changes?limit=1&cursor="+before, d.s.access).expect(200)
	// (Antwort "verloren" – Cursor nicht übernehmen)
	p2 := e.get("/api/v1/sync/changes?limit=1&cursor="+before, d.s.access).expect(200)
	if p1.str("data", "changes", 0, "id") != p2.str("data", "changes", 0, "id") || p1.str("data", "nextCursor") != p2.str("data", "nextCursor") {
		t.Fatal("erneuter Abruf liefert andere Daten")
	}
	// 3. Fehlgeschlagener Vorgang wird nicht als Erfolg gespeichert.
	fail := e.post("/api/v1/sync/complete", d.s.access, map[string]any{"result": "FAILED", "errorCode": "NETWORK_ERROR"}).expect(200)
	if fail.str("data", "syncStatus") != "FAILED" || fail.at("data", "lastSyncAt") != nil || fail.str("data", "lastSyncErrorCode") != "NETWORK_ERROR" {
		t.Fatal(fail.Raw)
	}
	d.sync()
	st := e.get("/api/v1/sync/status", d.s.access)
	if st.str("data", "device", "syncStatus") != "SUCCESS" || st.at("data", "device", "lastFailedSyncAt") == nil {
		t.Fatal(st.Raw)
	}
}

func TestSyncGleichzeitigeDoppelteUebertragungErzeugtKeinDuplikat(t *testing.T) {
	e := newEnv(t)
	d := e.newDevice("parallel@example.org", true)
	id, opID := uuid.NewString(), uuid.NewString()
	var wg sync.WaitGroup
	statuses := make([]string, 8)
	for i := range statuses {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r := e.post("/api/v1/sync/push", d.s.access, map[string]any{"changes": []any{op(opID, id, nil, "UPSERT", "Einmal")}})
			statuses[i] = r.str("data", "results", 0, "status")
		}(i)
	}
	wg.Wait()
	for _, s := range statuses {
		if s != "APPLIED" {
			t.Fatal(statuses)
		}
	}
	if serverCount(e, d.s.access) != 1 {
		t.Fatal("Duplikat entstanden")
	}
	var ops int
	_ = e.app.DB.Pool.QueryRow(t.Context(), `SELECT count(*) FROM sync_operations WHERE operation_id = $1`, opID).Scan(&ops)
	if ops != 1 {
		t.Fatal("Operation mehrfach gespeichert")
	}
}

func TestSyncKombinierterEndpunktUndHerkunft(t *testing.T) {
	e := newEnv(t)
	d := e.newDevice("echo@example.org", true)
	id := uuid.NewString()
	change := op(uuid.NewString(), id, nil, "UPSERT", "Mit Herkunft")
	change["clientLocalId"] = "room:42"
	r := e.post("/api/v1/sync", d.s.access, map[string]any{"cursor": "0", "changes": []any{change}}).expect(200)
	var echoed bool
	for _, c := range r.list("data", "pull", "changes") {
		if field(c, "id") == id {
			echoed = field(c, "echo") == true
			data := field(c, "data")
			if field(data, "clientLocalId") != "room:42" || field(data, "clientUpdatedAt") != "2026-10-05T07:00:00.000Z" ||
				field(data, "createdByDeviceId") != d.id || field(data, "lastOperationId") != change["operationId"] {
				t.Fatal(r.Raw)
			}
		}
	}
	if !echoed {
		t.Fatal("eigene Änderung nicht als echo markiert")
	}
	// Serverzeit (updatedAt) und Clientzeit sind getrennt; die (falsche) Clientzeit beeinflusst nichts.
	rec := e.get("/api/v1/daily-reports/"+id, d.s.access)
	if rec.str("data", "updatedAt") == rec.str("data", "clientUpdatedAt") {
		t.Fatal("Server übernimmt Clientzeit")
	}
	if r.str("data", "device", "deviceId") != d.id || r.at("data", "device", "lastSyncStartedAt") == nil {
		t.Fatal(r.Raw)
	}
	e.post("/api/v1/sync", d.s.access, map[string]any{"cursor": "-5"}).expect(400)
	e.post("/api/v1/sync", d.s.access, map[string]any{"limit": 0}).expect(422)
	e.post("/api/v1/sync/complete", d.s.access, map[string]any{"result": "SUCCESS", "cursor": "999999999"}).expect(422)
	e.post("/api/v1/sync/complete", d.s.access, map[string]any{"result": "VIELLEICHT"}).expect(422)
	e.post("/api/v1/sync/complete", d.s.access, map[string]any{"result": "FAILED", "errorCode": "kaputt<script>"}).expect(422)
	bad := op(uuid.NewString(), uuid.NewString(), nil, "UPSERT", "x")
	bad["clientLocalId"] = "<script>"
	res := e.post("/api/v1/sync/push", d.s.access, map[string]any{"changes": []any{bad}})
	if res.str("data", "results", 0, "status") != "REJECTED" {
		t.Fatal(res.Raw)
	}
}

func TestSyncAbgelaufenerCursorNachTombstoneBereinigung(t *testing.T) {
	e := newEnv(t)
	email := "alt@example.org"
	a := e.newDevice(email, true)
	old := e.newDevice(email, false)
	id := uuid.NewString()
	a.sync(op(uuid.NewString(), id, nil, "UPSERT", "Wird gelöscht"))
	old.sync() // altes Gerät kennt den Bericht …
	a.sync(op(uuid.NewString(), id, 1, "DELETE", ""))
	keep := uuid.NewString()
	a.sync(op(uuid.NewString(), keep, nil, "UPSERT", "Bleibt"))

	// Tombstone künstlich altern lassen und Wartung ausführen.
	ageRow(t, e, "daily_reports", "deleted_at", "400 days", id)
	res, err := e.app.RunMaintenance(t.Context())
	if err != nil || res.TombstonesPurged != 1 {
		t.Fatal(res, err)
	}
	var left int
	_ = e.app.DB.Pool.QueryRow(t.Context(), `SELECT count(*) FROM daily_reports WHERE id = $1`, id).Scan(&left)
	if left != 0 {
		t.Fatal("Tombstone nicht bereinigt")
	}
	// … hat die Löschung aber nie abgerufen: Sein Cursor ist jetzt ungültig.
	r := e.get("/api/v1/sync/changes?cursor="+old.cursor, old.s.access).expect(410)
	if r.code() != "SYNC_CURSOR_EXPIRED" {
		t.Fatal(r.Raw)
	}
	e.post("/api/v1/sync", old.s.access, map[string]any{"cursor": old.cursor}).expect(410)
	// Vollständige Neusynchronisierung liefert den korrekten Stand (gelöschter Bericht fehlt).
	full := e.get("/api/v1/sync/changes?cursor=0", old.s.access).expect(200)
	if strings.Contains(full.Raw, id) || !strings.Contains(full.Raw, keep) {
		t.Fatal(full.Raw)
	}
	st := e.get("/api/v1/sync/status", old.s.access)
	if st.str("data", "minValidCursor") == "0" {
		t.Fatal(st.Raw)
	}
	// Aktuelle Geräte sind nicht betroffen.
	e.get("/api/v1/sync/changes?cursor="+a.cursor, a.s.access).expect(200)
}
