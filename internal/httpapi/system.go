package httpapi

import (
	"context"
	"crypto/subtle"
	"html/template"
	"net/http"
	"runtime"
	"strings"
	"time"

	"berichtly-server/api"
	"berichtly-server/internal/apperr"
	"berichtly-server/internal/model"
)

// health ist der öffentliche Health-Check. Er verrät bewusst nur Zustände ("up"/"down") – keine
// Versionen, Hostnamen, Fehlermeldungen oder Ressourcenwerte.
func (a *API) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	dbUp := a.db.Ping(ctx) == nil
	status, code, dbState := "ok", http.StatusOK, "up"
	if !dbUp {
		status, code, dbState = "unavailable", http.StatusServiceUnavailable, "down"
		logger(r).Warn("Health-Check: Datenbank nicht erreichbar")
	}
	writeData(w, code, map[string]any{
		"status":     status,
		"components": map[string]string{"api": "up", "database": dbState},
	})
}

// live meldet nur, dass der Prozess Anfragen beantwortet (ohne Datenbankprüfung).
func (a *API) live(w http.ResponseWriter, _ *http.Request) {
	writeData(w, http.StatusOK, map[string]any{"status": "ok", "components": map[string]string{"api": "up"}})
}

type componentStatus struct {
	State         string `json:"state"` // UP | DEGRADED | DOWN
	LatencyMs     *int64 `json:"latencyMs,omitempty"`
	SchemaVersion *int   `json:"schemaVersion,omitempty"`
	PoolTotal     *int32 `json:"poolTotal,omitempty"`
	PoolIdle      *int32 `json:"poolIdle,omitempty"`
	PoolInUse     *int32 `json:"poolInUse,omitempty"`
	PoolMax       *int32 `json:"poolMax,omitempty"`
}

type resourceStatus struct {
	State         string `json:"state"`
	HeapAllocMB   uint64 `json:"heapAllocMb"`
	SysMemoryMB   uint64 `json:"sysMemoryMb"`
	Goroutines    int    `json:"goroutines"`
	DiskFreeMB    int64  `json:"diskFreeMb"`
	DiskMinFreeMB int64  `json:"diskMinFreeMb"`
	CPUs          int    `json:"cpus"`
}

// internalStatus liefert Details zu Datenbank, Ressourcen und Metriken. Nur mit
// `Authorization: Bearer <INTERNAL_STATUS_TOKEN>`; ohne gültiges Token wie ein unbekannter Endpunkt.
func (a *API) internalStatus(w http.ResponseWriter, r *http.Request) {
	token, _ := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.Status.InternalToken)) != 1 {
		writeError(w, r, apperr.New(http.StatusNotFound, apperr.CodeNotFound, "Der angeforderte Endpunkt existiert nicht."))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	db := componentStatus{State: "DOWN"}
	start := time.Now()
	if a.db.Ping(ctx) == nil {
		ms := time.Since(start).Milliseconds()
		db.State, db.LatencyMs = "UP", &ms
		if v, err := a.db.SchemaVersion(ctx); err == nil {
			db.SchemaVersion = &v
		}
	}
	st := a.db.Pool.Stat()
	total, idle, inUse, max := st.TotalConns(), st.IdleConns(), st.AcquiredConns(), st.MaxConns()
	db.PoolTotal, db.PoolIdle, db.PoolInUse, db.PoolMax = &total, &idle, &inUse, &max

	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	free := diskFreeMB(".")
	res := resourceStatus{State: "UP", HeapAllocMB: mem.HeapAlloc >> 20, SysMemoryMB: mem.Sys >> 20,
		Goroutines: runtime.NumGoroutine(), DiskFreeMB: free, DiskMinFreeMB: a.cfg.Status.MinFreeDiskMB,
		CPUs: runtime.NumCPU()}
	if free >= 0 && free < a.cfg.Status.MinFreeDiskMB {
		res.State = "DEGRADED"
	}

	overall, code := "UP", http.StatusOK
	switch {
	case db.State == "DOWN":
		overall, code = "DOWN", http.StatusServiceUnavailable
	case res.State != "UP":
		overall = "DEGRADED"
	}
	writeData(w, code, map[string]any{
		"state":         overall,
		"version":       a.version,
		"environment":   a.cfg.Env,
		"startedAt":     model.FormatTime(a.metrics.started),
		"uptimeSeconds": int64(time.Since(a.metrics.started).Seconds()),
		"database":      db,
		"resources":     res,
		"metrics":       a.metrics.snapshot(),
	})
}

func (a *API) openAPISpec(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	_, _ = w.Write(api.OpenAPI)
}

var swaggerPage = template.Must(template.New("docs").Parse(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Berichtly Server API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin="anonymous"></script>
<script>window.onload = () => { window.ui = SwaggerUIBundle({ url: "{{.}}", dom_id: "#swagger-ui" }); };</script>
</body>
</html>`))

// swaggerUI zeigt die Dokumentation. Die Swagger-UI-Dateien lädt der Browser des Entwicklers von unpkg.com;
// in Produktion ist die Doku standardmäßig deaktiviert.
func (a *API) swaggerUI(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = swaggerPage.Execute(w, "/api/openapi.yaml")
}
