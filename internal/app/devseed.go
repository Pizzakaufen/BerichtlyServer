package app

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"berichtly-server/internal/config"
	"berichtly-server/internal/model"
	"berichtly-server/internal/service"
)

const devEmail = "dev@berichtly.local"

// SeedDev legt ein Entwicklungskonto mit wenigen, eindeutig gekennzeichneten Beispielberichten an.
// Nur mit APP_ENV=development und nur auf ausdrücklichen Befehl (`seed-dev`) – niemals automatisch
// und niemals in Produktion. Das Passwort wird zufällig erzeugt und nur einmal angezeigt.
func (a *App) SeedDev(ctx context.Context) (email, password string, err error) {
	if a.Cfg.Env != config.Development {
		return "", "", errors.New("seed-dev ist nur mit APP_ENV=development erlaubt")
	}
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", "", err
	}
	password = base64.RawURLEncoding.EncodeToString(b)
	e, tz := devEmail, "Europe/Berlin"
	resp, err := a.Auth.Register(ctx, service.RegisterRequest{Email: &e, Password: &password, Timezone: &tz})
	if err != nil {
		return "", "", fmt.Errorf("Entwicklungskonto konnte nicht angelegt werden (existiert es bereits?): %w", err)
	}
	userID := uuid.MustParse(resp.Account.ID)
	berlin, _ := time.LoadLocation(tz)
	week := model.WeekContaining(model.DateOf(time.Now().In(berlin)))
	for i, day := range week.Days()[:3] {
		values := model.DailyValues{Date: day, Text: fmt.Sprintf("[Entwicklungsdaten] Beispieltätigkeit %d", i+1),
			Status: model.StatusDraft}
		if _, err := a.Reports.Daily.Create(ctx, userID, uuid.New(), values, nil); err != nil {
			return "", "", err
		}
	}
	return devEmail, password, nil
}
