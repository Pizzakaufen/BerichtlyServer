package httpapi

import "net/http"

// routesV1 registriert alle Endpunkte der API-Version 1. Bestehende 1.0-Endpunkte bleiben
// unverändert erreichbar; 1.1 ergänzt nur neue Endpunkte und optionale Felder.
func (a *API) routesV1(mux *http.ServeMux, v1 string) {
	auth := a.authenticated
	limit := func(l *limiter, h http.HandlerFunc) http.Handler { return a.rateLimit(l, h) }

	// System
	mux.HandleFunc("GET "+v1+"/health", a.health)
	mux.HandleFunc("GET "+v1+"/health/live", a.live)
	mux.HandleFunc("GET "+v1+"/health/ready", a.ready) // 1.1

	// Authentifizierung (eigene, strengere Rate Limits gegen Missbrauch)
	mux.Handle("POST "+v1+"/auth/register", limit(a.registerLimiter, a.register))
	mux.Handle("POST "+v1+"/auth/login", limit(a.loginLimiter, a.login))
	mux.Handle("POST "+v1+"/auth/refresh", limit(a.refreshLimiter, a.refresh))
	mux.HandleFunc("POST "+v1+"/auth/logout", auth(a.logout))
	mux.HandleFunc("POST "+v1+"/auth/logout-all", auth(a.logoutAll)) // 1.1

	// Konto, Sitzungen und Profil
	mux.HandleFunc("GET "+v1+"/account", auth(a.getAccount))
	mux.HandleFunc("PATCH "+v1+"/account", auth(a.updateAccount))
	mux.Handle("POST "+v1+"/account/password", limit(a.loginLimiter, auth(a.changePassword))) // 1.1
	mux.HandleFunc("GET "+v1+"/account/security-events", auth(a.securityEvents))              // 1.1
	mux.HandleFunc("GET "+v1+"/sessions", auth(a.listSessions))                               // 1.1
	mux.HandleFunc("DELETE "+v1+"/sessions/{id}", auth(a.revokeSession))                      // 1.1
	mux.HandleFunc("GET "+v1+"/profile", auth(a.getProfile))
	mux.HandleFunc("PUT "+v1+"/profile", auth(a.updateProfile))

	// Tagesberichte
	mux.HandleFunc("GET "+v1+"/daily-reports", auth(a.listDaily))
	mux.HandleFunc("POST "+v1+"/daily-reports", auth(a.createDaily))
	mux.HandleFunc("GET "+v1+"/daily-reports/{id}", auth(a.getDaily))
	mux.HandleFunc("PUT "+v1+"/daily-reports/{id}", auth(a.updateDaily))
	mux.HandleFunc("DELETE "+v1+"/daily-reports/{id}", auth(a.deleteDaily))

	// Wochenberichte und Wochenübersicht
	mux.HandleFunc("GET "+v1+"/weekly-reports", auth(a.listWeekly))
	mux.HandleFunc("POST "+v1+"/weekly-reports", auth(a.createWeekly))
	mux.HandleFunc("GET "+v1+"/weekly-reports/{id}", auth(a.getWeekly))
	mux.HandleFunc("PUT "+v1+"/weekly-reports/{id}", auth(a.updateWeekly))
	mux.HandleFunc("DELETE "+v1+"/weekly-reports/{id}", auth(a.deleteWeekly))
	mux.HandleFunc("GET "+v1+"/weeks/current", auth(a.currentWeek))
	mux.HandleFunc("GET "+v1+"/weeks/{date}", auth(a.week))
	mux.HandleFunc("GET "+v1+"/weeks/{isoYear}/{isoWeek}", auth(a.weekByISO)) // 1.1

	// Synchronisierung
	mux.HandleFunc("POST "+v1+"/sync", auth(a.syncCombined))          // 1.1
	mux.HandleFunc("POST "+v1+"/sync/complete", auth(a.syncComplete)) // 1.1
	mux.HandleFunc("GET "+v1+"/sync/changes", auth(a.syncPull))
	mux.HandleFunc("POST "+v1+"/sync/push", auth(a.syncPush))
	mux.HandleFunc("GET "+v1+"/sync/status", auth(a.syncStatus))

	// Geräte
	mux.HandleFunc("POST "+v1+"/devices", auth(a.registerDevice)) // 1.1
	mux.HandleFunc("GET "+v1+"/devices", auth(a.listDevices))
	mux.HandleFunc("GET "+v1+"/devices/{id}", auth(a.getDevice))      // 1.1
	mux.HandleFunc("PATCH "+v1+"/devices/{id}", auth(a.updateDevice)) // 1.1
	mux.HandleFunc("DELETE "+v1+"/devices/{id}", auth(a.signOutDevice))
}
