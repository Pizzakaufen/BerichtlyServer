package service

import (
	"context"
	"log/slog"
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

// SecurityEvents liefert die eigenen Sicherheitsereignisse (paginiert, neueste zuerst).
func (s *Account) SecurityEvents(ctx context.Context, userID uuid.UUID, limit, offset int) ([]model.SecurityEvent, int64, error) {
	return store.ListSecurityEvents(ctx, s.DB.Pool, userID, limit, offset)
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
func (s *Profiles) Update(ctx context.Context, userID uuid.UUID, base int, v model.ProfileValues) (out Outcome[model.Profile], err error) {
	err = s.DB.Tx(ctx, func(tx pgx.Tx) error {
		out, err = s.UpdateTx(ctx, tx, userID, base, v)
		return err
	})
	return out, err
}

func (s *Profiles) UpdateTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID, base int, v model.ProfileValues) (Outcome[model.Profile], error) {
	if err := store.LockUser(ctx, tx, userID); err != nil {
		return Outcome[model.Profile]{}, err
	}
	current, err := store.FindProfile(ctx, tx, userID, true)
	if err != nil || current == nil {
		return Outcome[model.Profile]{Kind: NotFound}, err
	}
	switch {
	case current.Values.Equal(v):
		return Outcome[model.Profile]{Kind: Applied, Record: current}, nil
	case current.Version != base:
		return Outcome[model.Profile]{Kind: Conflicted, Record: current, Reason: apperr.ReasonVersionMismatch}, nil
	}
	updated, err := store.UpdateProfile(ctx, tx, userID, base, v)
	if err != nil {
		return Outcome[model.Profile]{}, err
	}
	if updated == nil {
		return Outcome[model.Profile]{Kind: Conflicted, Record: current, Reason: apperr.ReasonVersionMismatch}, nil
	}
	return Outcome[model.Profile]{Kind: Applied, Record: updated, Changed: true}, nil
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

// DeviceUpdateRequest ändert Anzeigename und Versionsangaben eines Geräts (fehlende Felder bleiben).
type DeviceUpdateRequest struct {
	Name       *string `json:"name"`
	Platform   *string `json:"platform"`
	OSVersion  *string `json:"osVersion"`
	AppVersion *string `json:"appVersion"`
}

type Devices struct {
	DB  *store.DB
	Log *slog.Logger
}

// Register legt das Gerät an (oder aktiviert/aktualisiert es) und ordnet ihm die aktuelle Sitzung zu.
// So kann sich eine App auch nachträglich als Gerät registrieren, wenn beim Login keins übergeben wurde.
func (s *Devices) Register(ctx context.Context, p Principal, req DeviceRequest) (*model.Device, bool, error) {
	v := validate.New()
	info := validDevice(v, &req)
	if err := v.Err(); err != nil {
		return nil, false, err
	}
	var device *model.Device
	created := false
	err := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		existing, err := store.FindDeviceByDeviceID(ctx, tx, p.UserID, info.DeviceID)
		if err != nil {
			return err
		}
		created = existing == nil
		ref, err := store.UpsertDevice(ctx, tx, p.UserID, *info)
		if err != nil {
			return err
		}
		if err := store.BindSessionToDevice(ctx, tx, p.SessionID, ref); err != nil {
			return err
		}
		device, err = store.FindDeviceByRef(ctx, tx, p.UserID, ref)
		return err
	})
	return device, created, err
}

func (s *Devices) List(ctx context.Context, userID uuid.UUID, includeRevoked bool, limit, offset int) ([]model.Device, int64, error) {
	return store.ListDevices(ctx, s.DB.Pool, userID, includeRevoked, limit, offset)
}

func (s *Devices) Get(ctx context.Context, userID, deviceID uuid.UUID) (*model.Device, error) {
	d, err := store.FindDeviceByDeviceID(ctx, s.DB.Pool, userID, deviceID)
	if err == nil && d == nil {
		return nil, apperr.NotFound("Gerät")
	}
	return d, err
}

func (s *Devices) Update(ctx context.Context, userID, deviceID uuid.UUID, req DeviceUpdateRequest) (*model.Device, error) {
	v := validate.New()
	field := func(name string, val *string, max int) *string {
		if val == nil {
			return nil
		}
		t := strings.TrimSpace(*val)
		out, ok := v.Text(name, &t, validate.TextOpts{Max: max, SingleLine: true})
		if !ok {
			return nil
		}
		return &out
	}
	u := store.DeviceUpdate{
		Name:       field("name", req.Name, 100),
		Platform:   field("platform", req.Platform, 32),
		OSVersion:  field("osVersion", req.OSVersion, 32),
		AppVersion: field("appVersion", req.AppVersion, 32),
	}
	if u.Platform != nil {
		upper := strings.ToUpper(*u.Platform)
		u.Platform = &upper
	}
	if err := v.Err(); err != nil {
		return nil, err
	}
	ok, err := store.UpdateDevice(ctx, s.DB.Pool, userID, deviceID, u)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, apperr.NotFound("Gerät")
	}
	return s.Get(ctx, userID, deviceID)
}

// Revoke meldet ein Gerät ab: Alle Sitzungen des Geräts werden widerrufen, das Gerät wird als
// abgemeldet markiert. Berichte bleiben erhalten.
func (s *Devices) Revoke(ctx context.Context, p Principal, deviceID uuid.UUID) error {
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		d, err := store.FindDeviceByDeviceID(ctx, tx, p.UserID, deviceID)
		if err != nil {
			return err
		}
		if d == nil || d.RevokedAt != nil {
			return apperr.NotFound("Gerät")
		}
		if err := store.RevokeSessionsForDevice(ctx, tx, p.UserID, d.Ref, store.RevokeDeviceRemoved); err != nil {
			return err
		}
		if err := store.RevokeDevice(ctx, tx, p.UserID, d.Ref); err != nil {
			return err
		}
		uid := p.UserID
		s.Log.Info("Gerät abgemeldet", "user_id", p.UserID, "device_id", deviceID)
		return store.RecordSecurityEvent(ctx, tx, &uid, store.EventDeviceRevoked, &p.SessionID, &d.Ref)
	})
}
