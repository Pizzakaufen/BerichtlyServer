package app

import (
	"context"
	"time"

	"berichtly-server/internal/store"
)

// Retention liefert die konfigurierten Aufbewahrungsfristen.
func (a *App) Retention() store.Retention {
	r := a.Cfg.Retention
	return store.Retention{Tombstones: r.Tombstones, Operations: r.Operations, SecurityEvents: r.SecurityEvents, Sessions: r.Sessions}
}

// RunMaintenance führt einen Wartungslauf aus und protokolliert das Ergebnis (ohne Inhalte).
func (a *App) RunMaintenance(ctx context.Context) (store.MaintenanceResult, error) {
	res, err := a.DB.RunMaintenance(ctx, a.Retention())
	if err != nil {
		a.Log.Error("Wartung fehlgeschlagen", "error", err.Error())
		return res, err
	}
	if res.Skipped {
		a.Log.Info("Wartung übersprungen – läuft bereits an anderer Stelle")
		return res, nil
	}
	a.Log.Info("Wartung abgeschlossen", "tombstones", res.TombstonesPurged, "min_valid_cursor", res.MinValidCursor,
		"operations", res.OperationsPurged, "security_events", res.SecurityEventsPurged,
		"sessions", res.SessionsPurged, "refresh_tokens", res.RefreshTokensPurged)
	return res, nil
}

// StartMaintenance führt die Wartung im eingestellten Intervall aus (erster Lauf nach 5 Minuten),
// bis ctx beendet wird. Mehrere Instanzen sind über eine Datenbanksperre koordiniert.
func (a *App) StartMaintenance(ctx context.Context) {
	interval := a.Cfg.MaintenanceInterval
	if interval <= 0 {
		return
	}
	go func() {
		timer := time.NewTimer(5 * time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				runCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
				_, _ = a.RunMaintenance(runCtx)
				cancel()
				timer.Reset(interval)
			}
		}
	}()
}
