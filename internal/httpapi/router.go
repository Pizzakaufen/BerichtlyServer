package httpapi

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/config"
	"berichtly-server/internal/service"
	"berichtly-server/internal/store"
)

// Deps sind die Abhängigkeiten der HTTP-Schicht.
type Deps struct {
	Config   *config.Config
	DB       *store.DB
	Log      *slog.Logger
	Auth     *service.Auth
	Account  *service.Account
	Profiles *service.Profiles
	Reports  *service.Reports
	Sync     *service.Sync
	Devices  *service.Devices
	Version  string
}

type API struct {
	cfg      *config.Config
	db       *store.DB
	log      *slog.Logger
	auth     *service.Auth
	account  *service.Account
	profiles *service.Profiles
	reports  *service.Reports
	sync     *service.Sync
	devices  *service.Devices
	version  string
	metrics  *metrics
}

// New baut den vollständigen HTTP-Handler. Alle API-Endpunkte liegen unter /api/v1;
// eine spätere v2 wird als eigener Routenbaum ergänzt, ohne v1 zu verändern.
func New(d Deps) http.Handler {
	a := &API{cfg: d.Config, db: d.DB, log: d.Log, auth: d.Auth, account: d.Account, profiles: d.Profiles,
		reports: d.Reports, sync: d.Sync, devices: d.Devices, version: d.Version,
		metrics: &metrics{started: time.Now()}}

	authLimiter := newLimiter(d.Config.RateLimit.AuthPerMinute)
	limited := func(h http.HandlerFunc) http.Handler { return a.rateLimit(authLimiter, h) }

	mux := http.NewServeMux()
	const v1 = "/api/v1"

	// System
	mux.HandleFunc("GET "+v1+"/health", a.health)
	mux.HandleFunc("GET "+v1+"/health/live", a.live)

	// Authentifizierung (strengeres Rate Limit gegen Brute-Force)
	mux.Handle("POST "+v1+"/auth/register", limited(a.register))
	mux.Handle("POST "+v1+"/auth/login", limited(a.login))
	mux.Handle("POST "+v1+"/auth/refresh", limited(a.refresh))
	mux.HandleFunc("POST "+v1+"/auth/logout", a.authenticated(a.logout))

	// Konto und Profil
	mux.HandleFunc("GET "+v1+"/account", a.authenticated(a.getAccount))
	mux.HandleFunc("PATCH "+v1+"/account", a.authenticated(a.updateAccount))
	mux.HandleFunc("GET "+v1+"/profile", a.authenticated(a.getProfile))
	mux.HandleFunc("PUT "+v1+"/profile", a.authenticated(a.updateProfile))

	// Tagesberichte
	mux.HandleFunc("GET "+v1+"/daily-reports", a.authenticated(a.listDaily))
	mux.HandleFunc("POST "+v1+"/daily-reports", a.authenticated(a.createDaily))
	mux.HandleFunc("GET "+v1+"/daily-reports/{id}", a.authenticated(a.getDaily))
	mux.HandleFunc("PUT "+v1+"/daily-reports/{id}", a.authenticated(a.updateDaily))
	mux.HandleFunc("DELETE "+v1+"/daily-reports/{id}", a.authenticated(a.deleteDaily))

	// Wochenberichte und Wochenübersicht
	mux.HandleFunc("GET "+v1+"/weekly-reports", a.authenticated(a.listWeekly))
	mux.HandleFunc("POST "+v1+"/weekly-reports", a.authenticated(a.createWeekly))
	mux.HandleFunc("GET "+v1+"/weekly-reports/{id}", a.authenticated(a.getWeekly))
	mux.HandleFunc("PUT "+v1+"/weekly-reports/{id}", a.authenticated(a.updateWeekly))
	mux.HandleFunc("DELETE "+v1+"/weekly-reports/{id}", a.authenticated(a.deleteWeekly))
	mux.HandleFunc("GET "+v1+"/weeks/current", a.authenticated(a.currentWeek))
	mux.HandleFunc("GET "+v1+"/weeks/{date}", a.authenticated(a.week))

	// Synchronisierung
	mux.HandleFunc("GET "+v1+"/sync/changes", a.authenticated(a.syncPull))
	mux.HandleFunc("POST "+v1+"/sync/push", a.authenticated(a.syncPush))
	mux.HandleFunc("GET "+v1+"/sync/status", a.authenticated(a.syncStatus))

	// Geräte
	mux.HandleFunc("GET "+v1+"/devices", a.authenticated(a.listDevices))
	mux.HandleFunc("DELETE "+v1+"/devices/{id}", a.authenticated(a.signOutDevice))

	// Interner Status (nur mit INTERNAL_STATUS_TOKEN) und API-Dokumentation (optional)
	if d.Config.Status.InternalToken != "" {
		mux.HandleFunc("GET /internal/status", a.internalStatus)
	}
	if d.Config.APIDocs {
		mux.HandleFunc("GET /api/openapi.yaml", a.openAPISpec)
		mux.HandleFunc("GET /api/docs", a.swaggerUI)
	}

	apiLimiter := newLimiter(d.Config.RateLimit.APIPerMinute)
	var h http.Handler = jsonFallbackErrors(mux)
	h = a.rateLimit(apiLimiter, h)
	h = a.cors(h)
	h = securityHeaders(h)
	return a.observe(h)
}

// jsonFallbackErrors ersetzt die Klartext-Antworten des ServeMux (404 unbekannter Endpunkt,
// 405 falsche Methode) durch die einheitliche JSON-Fehlerstruktur.
func jsonFallbackErrors(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); pattern == "" {
			mux.ServeHTTP(&fallbackWriter{ResponseWriter: w, r: r}, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

type fallbackWriter struct {
	http.ResponseWriter
	r          *http.Request
	suppressed bool
}

func (m *fallbackWriter) WriteHeader(code int) {
	if strings.HasPrefix(m.Header().Get("Content-Type"), "text/plain") {
		switch code {
		case http.StatusNotFound:
			m.suppressed = true
			writeError(m.ResponseWriter, m.r, apperr.New(http.StatusNotFound, apperr.CodeNotFound,
				"Der angeforderte Endpunkt existiert nicht."))
			return
		case http.StatusMethodNotAllowed:
			m.suppressed = true
			writeError(m.ResponseWriter, m.r, apperr.New(http.StatusMethodNotAllowed, apperr.CodeMethodNotAllowed,
				"HTTP-Methode nicht erlaubt."))
			return
		}
	}
	m.ResponseWriter.WriteHeader(code)
}

func (m *fallbackWriter) Write(b []byte) (int, error) {
	if m.suppressed {
		return len(b), nil
	}
	return m.ResponseWriter.Write(b)
}
