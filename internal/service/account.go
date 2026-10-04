package service

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/model"
	"berichtly-server/internal/store"
	"berichtly-server/internal/validate"
)

// ---------------------------------------------------------------------------
// Konto
// ---------------------------------------------------------------------------

type AccountUpdateRequest struct {
	// IANA-Zeitzone, nach der Berichtsdaten ("heute", aktuelle Woche) interpretiert werden.
	Timezone *string `json:"timezone"`
}

type Account struct{ DB *store.DB }

func (s *Account) Get(ctx context.Context, userID uuid.UUID) (*model.User, error) {
	u, err := store.FindUserByID(ctx, s.DB.Pool, userID)
	if err == nil && u == nil {
		return nil, apperr.NotFound("Konto")
	}
	return u, err
}

func (s *Account) Update(ctx context.Context, userID uuid.UUID, req AccountUpdateRequest) (*model.User, error) {
	v := validate.New()
	loc, _ := v.Timezone("timezone", req.Timezone)
	if err := v.Err(); err != nil {
		return nil, err
	}
	if loc != nil {
		if err := store.UpdateUserTimezone(ctx, s.DB.Pool, userID, loc.String()); err != nil {
			return nil, err
		}
	}
	return s.Get(ctx, userID)
}

// ---------------------------------------------------------------------------
// Profil
// ---------------------------------------------------------------------------

// ProfileRequest ist der vollständige Profilinhalt (PUT ersetzt alle Felder; fehlende Textfelder
// werden geleert). `version` ist die Basisversion.
type ProfileRequest struct {
	Version       *int    `json:"version"`
	Name          *string `json:"name"`
	Profession    *string `json:"profession"`
	Company       *string `json:"company"`
	Department    *string `json:"department"`
	TrainerName   *string `json:"trainerName"`
	TrainingStart *string `json:"trainingStart"`
	TrainingEnd   *string `json:"trainingEnd"`
	WritingStyle  *string `json:"writingStyle"`
}

func (r ProfileRequest) Values(v *validate.V) model.ProfileValues {
	line := func(field string, val *string, max int) string {
		if val != nil {
			t := strings.TrimSpace(*val)
			val = &t
		}
		s, _ := v.Text(field, val, validate.TextOpts{Max: max, SingleLine: true})
		return s
	}
	out := model.ProfileValues{
		Name:        line("name", r.Name, 120),
		Profession:  line("profession", r.Profession, 120),
		Company:     line("company", r.Company, 160),
		Department:  line("department", r.Department, 120),
		TrainerName: line("trainerName", r.TrainerName, 120),
	}
	out.TrainingStart, _ = v.Date("trainingStart", r.TrainingStart, false)
	out.TrainingEnd, _ = v.Date("trainingEnd", r.TrainingEnd, false)
	if out.TrainingStart != nil && out.TrainingEnd != nil && out.TrainingEnd.Before(*out.TrainingStart) {
		v.Add("trainingEnd", "before_training_start")
	}
	style, _ := v.Enum("writingStyle", r.WritingStyle, model.WritingStyles, "NEUTRAL")
	out.WritingStyle = model.WritingStyle(style)
	return out
}

type Profiles struct{ DB *store.DB }

func (s *Profiles) Get(ctx context.Context, userID uuid.UUID) (*model.Profile, error) {
	p, err := store.FindProfile(ctx, s.DB.Pool, userID, false)
	if err == nil && p == nil {
		return nil, apperr.NotFound("Profil")
	}
	return p, err
}

// Update folgt denselben Konfliktregeln wie Berichte.
func (s *Profiles) Update(ctx context.Context, userID uuid.UUID, base int, v model.ProfileValues) (Outcome[model.Profile], error) {
	var out Outcome[model.Profile]
	err := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		out = Outcome[model.Profile]{}
		if err := store.LockUser(ctx, tx, userID); err != nil {
			return err
		}
		current, err := store.FindProfile(ctx, tx, userID, true)
		if err != nil || current == nil {
			out.Kind = NotFound
			return err
		}
		switch {
		case current.Values.Equal(v):
			out = Outcome[model.Profile]{Kind: Applied, Record: current}
		case current.Version != base:
			out = Outcome[model.Profile]{Kind: Conflicted, Record: current, Reason: apperr.ReasonVersionMismatch}
		default:
			updated, err := store.UpdateProfile(ctx, tx, userID, base, v)
			if err != nil {
				return err
			}
			if updated == nil {
				out = Outcome[model.Profile]{Kind: Conflicted, Record: current, Reason: apperr.ReasonVersionMismatch}
			} else {
				out = Outcome[model.Profile]{Kind: Applied, Record: updated, Changed: true}
			}
		}
		return nil
	})
	return out, err
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

type Devices struct{ DB *store.DB }

func (s *Devices) List(ctx context.Context, userID uuid.UUID) ([]model.Device, error) {
	return store.ListDevices(ctx, s.DB.Pool, userID)
}

// SignOut meldet ein Gerät ab: Alle Sitzungen des Geräts werden widerrufen, Daten bleiben erhalten.
func (s *Devices) SignOut(ctx context.Context, userID, deviceID uuid.UUID) error {
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		d, err := store.FindDeviceByDeviceID(ctx, tx, userID, deviceID)
		if err != nil {
			return err
		}
		if d == nil {
			return apperr.NotFound("Gerät")
		}
		return store.RevokeSessionsForDevice(ctx, tx, userID, d.Ref, store.RevokeDeviceRemoved)
	})
}
