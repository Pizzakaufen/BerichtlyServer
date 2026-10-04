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

	loginLimiter, accountLimiter, registerLimiter, refreshLimiter *limiter
}

// New baut den vollständigen HTTP-Handler.
//
// Versionierung: Alle Endpunkte der API-Version 1 werden in routesV1 unter /api/v1 registriert.
// Eine spätere v2 erhält eine eigene Funktion routesV2 unter /api/v2; Services und Datenbank
// werden geteilt, v1 bleibt unverändert bestehen, solange App-Versionen sie nutzen.
func New(d Deps) http.Handler {
	rl := d.Config.RateLimit
	a := &API{cfg: d.Config, db: d.DB, log: d.Log, auth: d.Auth, account: d.Account, profiles: d.Profiles,
		reports: d.Reports, sync: d.Sync, devices: d.Devices, version: d.Version,
		metrics:         &metrics{started: time.Now()},
		loginLimiter:    newLimiter(rl.LoginPerMinute),
		accountLimiter:  newLimiter(rl.LoginPerAccountPerMinute),
		registerLimiter: newLimiter(rl.RegisterPerMinute),
		refreshLimiter:  newLimiter(rl.RefreshPerMinute),
	}

	mux := http.NewServeMux()
	a.routesV1(mux, "/api/v1")

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
	h = a.securityHeaders(h)
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
