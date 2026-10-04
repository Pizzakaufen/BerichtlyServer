package httpapi_test

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func (e *env) loginDevice(email, deviceID, name string) session {
	e.t.Helper()
	return e.post("/api/v1/auth/login", "", map[string]any{"email": email, "password": defaultPassword,
		"device": map[string]any{"id": deviceID, "name": name, "platform": "android", "osVersion": "15", "appVersion": "2.2.0"}}).
		expect(200).session()
}

func eventTypes(r *response) []string {
	var out []string
	for _, ev := range r.list("data") {
		out = append(out, field(ev, "type").(string))
	}
	return out
}

func TestMehrereGeraeteProKontoVerwalten(t *testing.T) {
	e := newEnv(t)
	email := "geraete@example.org"
	phone, tablet := uuid.NewString(), uuid.NewString()
	e.register(email)
	s1 := e.loginDevice(email, phone, "Pixel 9")
	s2 := e.loginDevice(email, tablet, "Galaxy Tab")

	list := e.get("/api/v1/devices", s1.access).expect(200)
	if list.num("meta", "total") != 2 || len(list.list("data")) != 2 {
		t.Fatal(list.Raw)
	}
	d := e.get("/api/v1/devices/"+phone, s1.access).expect(200)
	if d.str("data", "name") != "Pixel 9" || d.str("data", "platform") != "ANDROID" || d.str("data", "osVersion") != "15" ||
		d.str("data", "appVersion") != "2.2.0" || d.str("data", "syncStatus") != "NEVER" || d.at("data", "current") != true ||
		d.at("data", "lastSyncAt") != nil {
		t.Fatal(d.Raw)
	}

	// Anzeigename und App-Version aktualisieren; nicht gesendete Felder bleiben.
	u := e.patch("/api/v1/devices/"+phone, s1.access, map[string]any{"name": "Mein Handy", "appVersion": "2.2.1"}).expect(200)
	if u.str("data", "name") != "Mein Handy" || u.str("data", "appVersion") != "2.2.1" || u.str("data", "osVersion") != "15" {
		t.Fatal(u.Raw)
	}
	e.patch("/api/v1/devices/"+phone, s1.access, map[string]any{"name": strings.Repeat("x", 101)}).expect(422)
	e.patch("/api/v1/devices/"+phone, s1.access, map[string]any{"name": "Zeile\nUmbruch"}).expect(422)

	// Tablet abmelden: dessen Sitzung ist sofort ungültig, das Gerät verschwindet aus der Liste.
	e.delete("/api/v1/devices/"+tablet, s1.access).expect(204)
	e.get("/api/v1/profile", s2.access).expect(401)
	e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": s2.refresh}).expect(401)
	if e.get("/api/v1/devices", s1.access).num("meta", "total") != 1 {
		t.Fatal("abgemeldetes Gerät noch aktiv gelistet")
	}
	all := e.get("/api/v1/devices?includeRevoked=true", s1.access)
	if all.num("meta", "total") != 2 {
		t.Fatal(all.Raw)
	}
	e.delete("/api/v1/devices/"+tablet, s1.access).expect(404) // bereits abgemeldet
	e.patch("/api/v1/devices/"+tablet, s1.access, map[string]any{"name": "x"}).expect(404)

	// Erneute Anmeldung reaktiviert dasselbe Gerät (gleiche stabile ID, kein Duplikat).
	e.loginDevice(email, tablet, "Galaxy Tab")
	if e.get("/api/v1/devices?includeRevoked=true", s1.access).num("meta", "total") != 2 {
		t.Fatal("Gerät doppelt angelegt")
	}
	e.get("/api/v1/devices?limit=1&page=2", s1.access).expect(200)
	e.get("/api/v1/devices?includeRevoked=vielleicht", s1.access).expect(400)
}

func TestGeraetNachtraeglichRegistrieren(t *testing.T) {
	e := newEnv(t)
	s := e.register("") // Login ohne Geräteangabe
	e.post("/api/v1/sync/complete", s.access, map[string]any{"result": "SUCCESS", "cursor": "0"}).expect(409)

	id := uuid.NewString()
	r := e.post("/api/v1/devices", s.access, map[string]any{"id": id, "name": "Pixel", "osVersion": "14", "appVersion": "2.2.0"}).expect(201)
	if r.str("data", "id") != id || r.at("data", "current") != true {
		t.Fatal(r.Raw)
	}
	// Erneutes Registrieren ist idempotent.
	e.post("/api/v1/devices", s.access, map[string]any{"id": id, "name": "Pixel"}).expect(200)
	// Die Sitzung ist jetzt an das Gerät gebunden: Sync-Status ist gerätebezogen.
	if st := e.get("/api/v1/sync/status", s.access); st.str("data", "device", "deviceId") != id {
		t.Fatal(st.Raw)
	}
	e.post("/api/v1/devices", s.access, map[string]any{"name": "ohne ID"}).expect(422)
	e.post("/api/v1/devices", s.access, map[string]any{"id": "keine-uuid"}).expect(422)
}

func TestGeraeteUndSitzungenAndererBenutzerSindUnerreichbar(t *testing.T) {
	e := newEnv(t)
	deviceA := uuid.NewString()
	a := e.register("", map[string]any{"device": map[string]any{"id": deviceA, "name": "Gerät A"}})
	b := e.register("")

	e.get("/api/v1/devices/"+deviceA, b.access).expect(404)
	e.patch("/api/v1/devices/"+deviceA, b.access, map[string]any{"name": "gekapert"}).expect(404)
	e.delete("/api/v1/devices/"+deviceA, b.access).expect(404)
	e.delete("/api/v1/sessions/"+a.sessionID, b.access).expect(404)
	// B registriert ein Gerät mit derselben Geräte-ID: eigenes Gerät, As Gerät bleibt unberührt.
	e.post("/api/v1/devices", b.access, map[string]any{"id": deviceA, "name": "Bs Gerät"}).expect(201)
	if e.get("/api/v1/devices/"+deviceA, a.access).str("data", "name") != "Gerät A" {
		t.Fatal("Gerät von A verändert")
	}
	e.get("/api/v1/profile", a.access).expect(200)
	for _, path := range []string{"/api/v1/sessions", "/api/v1/account/security-events", "/api/v1/devices"} {
		if raw := e.get(path, b.access).expect(200).Raw; strings.Contains(raw, a.sessionID) {
			t.Fatalf("%s enthält Daten von A", path)
		}
	}
}

func TestSitzungenAuflistenUndBeenden(t *testing.T) {
	e := newEnv(t)
	email := "sitzungen@example.org"
	s1 := e.register(email)
	s2 := e.loginDevice(email, uuid.NewString(), "Zweitgerät")

	list := e.get("/api/v1/sessions", s1.access).expect(200)
	if list.num("meta", "total") != 2 {
		t.Fatal(list.Raw)
	}
	current := 0
	for _, s := range list.list("data") {
		if field(s, "current") == true {
			current++
			if field(s, "id") != s1.sessionID {
				t.Fatal("falsche Sitzung als aktuell markiert")
			}
		}
	}
	if current != 1 {
		t.Fatal(list.Raw)
	}
	e.delete("/api/v1/sessions/"+s2.sessionID, s1.access).expect(204)
	e.get("/api/v1/profile", s2.access).expect(401)
	e.delete("/api/v1/sessions/"+uuid.NewString(), s1.access).expect(404)
	e.delete("/api/v1/sessions/kaputt", s1.access).expect(400)
}

func TestAlleSitzungenAbmelden(t *testing.T) {
	e := newEnv(t)
	email := "alle@example.org"
	s1 := e.register(email)
	s2 := e.loginDevice(email, uuid.NewString(), "Tablet")
	r := e.post("/api/v1/auth/logout-all", s1.access, nil).expect(200)
	if r.num("data", "revokedSessions") != 2 {
		t.Fatal(r.Raw)
	}
	for _, s := range []session{s1, s2} {
		e.get("/api/v1/profile", s.access).expect(401)
		e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": s.refresh}).expect(401)
	}
}

func TestPasswortAendernWiderruftAndereSitzungen(t *testing.T) {
	e := newEnv(t)
	email := "pw@example.org"
	s1 := e.register(email)
	s2 := e.loginDevice(email, uuid.NewString(), "Anderes Gerät")
	newPw := "neues-Passwort-2026!"

	e.post("/api/v1/account/password", s1.access, map[string]any{"currentPassword": "falsch-falsch", "newPassword": newPw}).expect(401)
	e.post("/api/v1/account/password", s1.access, map[string]any{"currentPassword": defaultPassword, "newPassword": "kurz"}).expect(422)
	e.post("/api/v1/account/password", s1.access, map[string]any{"currentPassword": defaultPassword, "newPassword": defaultPassword}).expect(422)
	e.post("/api/v1/account/password", s1.access, map[string]any{"currentPassword": defaultPassword, "newPassword": newPw}).expect(204)

	e.get("/api/v1/profile", s1.access).expect(200) // aktuelle Sitzung bleibt
	e.get("/api/v1/profile", s2.access).expect(401) // andere Sitzungen widerrufen
	e.login(email, defaultPassword).expect(401)
	e.login(email, newPw).expect(200)

	var hash string
	_ = e.app.DB.Pool.QueryRow(t.Context(), `SELECT password_hash FROM users WHERE email = $1`, email).Scan(&hash)
	if !strings.HasPrefix(hash, "$argon2id$") || strings.Contains(hash, newPw) {
		t.Fatal("neues Passwort nicht sicher gespeichert")
	}
}

func TestSicherheitsereignisseOhneSensibleDaten(t *testing.T) {
	e := newEnv(t)
	email := "audit@example.org"
	s := e.register(email)
	e.login(email, "falsches-Passwort-1").expect(401)
	e.login("unbekannt@example.org", "egal-egal-egal").expect(401)
	dev := uuid.NewString()
	s2 := e.loginDevice(email, dev, "Handy")
	e.delete("/api/v1/devices/"+dev, s.access).expect(204)
	e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": s.refresh}).expect(200)
	e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": s.refresh}).expect(401) // Wiederverwendung
	_ = s2

	// Nach der Wiederverwendung ist die ursprüngliche Sitzung widerrufen – neu anmelden.
	fresh := e.post("/api/v1/auth/login", "", map[string]any{"email": email, "password": defaultPassword}).expect(200).session()
	ev := e.get("/api/v1/account/security-events?limit=100", fresh.access).expect(200)
	types := strings.Join(eventTypes(ev), ",")
	for _, want := range []string{"REGISTERED", "LOGIN_FAILED", "LOGIN_SUCCEEDED", "DEVICE_REVOKED", "REFRESH_TOKEN_REUSE"} {
		if !strings.Contains(types, want) {
			t.Fatalf("Ereignis %s fehlt: %s", want, types)
		}
	}
	if strings.Contains(types, "LOGIN_FAILED_UNKNOWN_ACCOUNT") {
		t.Fatal("Ereignis eines fremden/unbekannten Kontos sichtbar")
	}
	// In der Tabelle stehen weder E-Mail-Adressen noch Passwörter oder Tokens.
	var leaked int
	_ = e.app.DB.Pool.QueryRow(t.Context(), `SELECT count(*) FROM security_events e
		WHERE row_to_json(e)::text ILIKE '%example.org%' OR row_to_json(e)::text LIKE '%brt_%'
		   OR row_to_json(e)::text LIKE '%falsches-Passwort%'`).Scan(&leaked)
	if leaked != 0 {
		t.Fatal("sensible Daten in Sicherheitsereignissen")
	}
	var unknown int
	_ = e.app.DB.Pool.QueryRow(t.Context(), `SELECT count(*) FROM security_events
		WHERE event_type = 'LOGIN_FAILED_UNKNOWN_ACCOUNT' AND user_id IS NULL`).Scan(&unknown)
	if unknown != 1 {
		t.Fatal("Fehlversuch für unbekanntes Konto nicht protokolliert")
	}
}

func TestLoginLimitProKonto(t *testing.T) {
	e := newEnv(t, opts{overrides: map[string]string{"RATE_LIMIT_LOGIN_PER_ACCOUNT_PER_MINUTE": "3"}})
	e.register("ziel@example.org")
	for i := 0; i < 3; i++ {
		e.login("ziel@example.org", "falsch-falsch-123").expect(401)
	}
	r := e.login("ZIEL@example.org", defaultPassword).expect(429) // gleiche Adresse, andere Schreibweise
	if r.code() != "RATE_LIMITED" || r.Header.Get("Retry-After") == "" {
		t.Fatal(r.Raw)
	}
	e.register("anderes@example.org")
	e.login("anderes@example.org", defaultPassword).expect(200) // andere Konten unberührt
}

func TestRefreshHatEigenesGroesseresLimit(t *testing.T) {
	e := newEnv(t, opts{overrides: map[string]string{
		"RATE_LIMIT_AUTH_PER_MINUTE": "", "RATE_LIMIT_LOGIN_PER_MINUTE": "2", "RATE_LIMIT_REGISTER_PER_MINUTE": "1",
		"RATE_LIMIT_REFRESH_PER_MINUTE": "5"}})
	s := e.register("")
	e.post("/api/v1/auth/register", "", map[string]any{"email": "zwei@example.org", "password": defaultPassword}).expect(429)
	// Refresh ist vom Login-/Registrierungslimit unabhängig.
	tok := s.refresh
	for i := 0; i < 5; i++ {
		tok = e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": tok}).expect(200).session().refresh
	}
	e.post("/api/v1/auth/refresh", "", map[string]any{"refreshToken": tok}).expect(429)
}
