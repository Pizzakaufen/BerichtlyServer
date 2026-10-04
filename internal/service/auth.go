package service

import (
	"context"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/config"
	"berichtly-server/internal/model"
	"berichtly-server/internal/security"
	"berichtly-server/internal/store"
	"berichtly-server/internal/validate"
)

const (
	PasswordMinLength = 10
	PasswordMaxLength = 128
)

var emailPattern = regexp.MustCompile(`^[a-z0-9.!#$%&'*+/=?^_` + "`" + `{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)

// DeviceRequest beschreibt das anmeldende Gerät (optional beim Login, Pflicht bei POST /devices).
type DeviceRequest struct {
	ID         *string `json:"id"` // stabile, auf dem Gerät einmalig erzeugte UUID
	Name       *string `json:"name"`
	Platform   *string `json:"platform"`
	OSVersion  *string `json:"osVersion"`
	AppVersion *string `json:"appVersion"`
}

type RegisterRequest struct {
	Email    *string        `json:"email"`
	Password *string        `json:"password"`
	Timezone *string        `json:"timezone"`
	Device   *DeviceRequest `json:"device"`
}

type LoginRequest struct {
	Email    *string        `json:"email"`
	Password *string        `json:"password"`
	Device   *DeviceRequest `json:"device"`
}

type RefreshRequest struct {
	RefreshToken *string `json:"refreshToken"`
}

type PasswordChangeRequest struct {
	CurrentPassword *string `json:"currentPassword"`
	NewPassword     *string `json:"newPassword"`
}

type TokenResponse struct {
	TokenType             string `json:"tokenType"`
	AccessToken           string `json:"accessToken"`
	AccessTokenExpiresAt  string `json:"accessTokenExpiresAt"`
	ExpiresIn             int64  `json:"expiresIn"` // Sekunden
	RefreshToken          string `json:"refreshToken"`
	RefreshTokenExpiresAt string `json:"refreshTokenExpiresAt"`
	SessionID             string `json:"sessionId"`
}

type AuthResponse struct {
	Account model.AccountDTO `json:"account"`
	Tokens  TokenResponse    `json:"tokens"`
}

// Principal ist der authentifizierte Benutzer eines Requests.
type Principal struct {
	UserID    uuid.UUID
	SessionID uuid.UUID
	DeviceRef *uuid.UUID
}

type Auth struct {
	DB     *store.DB
	Cfg    config.Auth
	Hasher *security.PasswordHasher
	Tokens *security.Tokens
	Log    *slog.Logger
}

func (s *Auth) Register(ctx context.Context, req RegisterRequest) (*AuthResponse, error) {
	if !s.Cfg.RegistrationEnabled {
		return nil, apperr.New(http.StatusForbidden, apperr.CodeRegistrationDisabled,
			"Die Registrierung ist auf diesem Server deaktiviert.")
	}
	v := validate.New()
	email := ValidEmail(v, req.Email)
	if req.Password == nil {
		v.Add("password", "required")
	} else if issue := PasswordIssue(*req.Password, email); issue != "" {
		v.Add("password", issue)
	}
	tz := s.Cfg.DefaultTimezone
	if loc, ok := v.Timezone("timezone", req.Timezone); ok && loc != nil {
		tz = loc.String()
	}
	device := validDevice(v, req.Device)
	if err := v.Err(); err != nil {
		return nil, err
	}

	hash, err := s.Hasher.Hash(ctx, *req.Password)
	if err != nil {
		return nil, err
	}
	userID := uuid.New()
	var resp *AuthResponse
	err = s.DB.Tx(ctx, func(tx pgx.Tx) error {
		if err := store.InsertUser(ctx, tx, userID, email, hash, tz); err != nil {
			return err
		}
		if err := store.InsertEmptyProfile(ctx, tx, userID); err != nil {
			return err
		}
		user, err := store.FindUserByID(ctx, tx, userID)
		if err != nil {
			return err
		}
		resp, err = s.createSession(ctx, tx, user, device, store.EventRegistered)
		return err
	})
	if store.IsUniqueViolation(err) {
		return nil, apperr.New(http.StatusConflict, apperr.CodeEmailAlreadyRegistered,
			"Für diese E-Mail-Adresse existiert bereits ein Konto.")
	}
	if err != nil {
		return nil, err
	}
	s.Log.Info("Neues Benutzerkonto registriert", "user_id", userID)
	return resp, nil
}

func (s *Auth) Login(ctx context.Context, req LoginRequest) (*AuthResponse, error) {
	v := validate.New()
	email := ValidEmail(v, req.Email)
	password, _ := v.Text("password", req.Password, validate.TextOpts{Max: PasswordMaxLength, Required: true})
	device := validDevice(v, req.Device)
	if err := v.Err(); err != nil {
		return nil, err
	}

	user, err := store.FindUserByEmail(ctx, s.DB.Pool, email)
	if err != nil {
		return nil, err
	}
	if user == nil {
		s.Hasher.VerifyDummy(ctx, password)
		s.event(ctx, nil, store.EventLoginUnknownAccount, nil, nil)
		return nil, invalidCredentials()
	}
	if user.Locked {
		return nil, apperr.New(http.StatusTooManyRequests, apperr.CodeAccountTemporarilyLocked,
			"Zu viele fehlgeschlagene Anmeldeversuche. Bitte später erneut versuchen.")
	}
	ok, err := s.Hasher.Verify(ctx, password, user.PasswordHash)
	if err != nil {
		return nil, err
	}
	if !ok {
		if err := store.RecordFailedLogin(ctx, s.DB.Pool, user.ID, s.Cfg.MaxFailedLogins, s.Cfg.LockoutDuration); err != nil {
			return nil, err
		}
		s.event(ctx, &user.ID, store.EventLoginFailed, nil, nil)
		if after, err := store.FindUserByID(ctx, s.DB.Pool, user.ID); err == nil && after != nil && after.Locked {
			s.event(ctx, &user.ID, store.EventAccountLocked, nil, nil)
			s.Log.Warn("Konto nach Fehlversuchen vorübergehend gesperrt", "user_id", user.ID)
		}
		s.Log.Info("Fehlgeschlagener Login", "user_id", user.ID)
		return nil, invalidCredentials()
	}
	if user.Status != model.UserActive {
		return nil, apperr.New(http.StatusForbidden, apperr.CodeAccountDisabled, "Dieses Konto ist deaktiviert.")
	}
	var rehash *string
	if s.Hasher.NeedsRehash(user.PasswordHash) {
		h, err := s.Hasher.Hash(ctx, password)
		if err != nil {
			return nil, err
		}
		rehash = &h
	}
	var resp *AuthResponse
	err = s.DB.Tx(ctx, func(tx pgx.Tx) error {
		if err := store.RecordSuccessfulLogin(ctx, tx, user.ID, rehash); err != nil {
			return err
		}
		resp, err = s.createSession(ctx, tx, user, device, store.EventLoginSucceeded)
		return err
	})
	if err != nil {
		return nil, err
	}
	s.Log.Info("Login erfolgreich", "user_id", user.ID)
	return resp, nil
}

// Refresh tauscht ein Refresh Token gegen ein neues Token-Paar (Rotation). Wird ein bereits
// benutztes Token erneut vorgelegt, gilt die Sitzung als kompromittiert und wird widerrufen.
func (s *Auth) Refresh(ctx context.Context, req RefreshRequest) (*AuthResponse, error) {
	if req.RefreshToken == nil || *req.RefreshToken == "" {
		return nil, apperr.Validation([]apperr.FieldError{{Field: "refreshToken", Issue: "required"}})
	}
	hash := security.HashRefreshToken(*req.RefreshToken)
	if hash == nil {
		return nil, invalidRefreshToken()
	}
	var resp *AuthResponse
	err := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		row, err := store.FindRefreshTokenForUpdate(ctx, tx, hash)
		if err != nil || row == nil {
			return err
		}
		switch {
		case row.Used:
			s.Log.Warn("Wiederverwendung eines Refresh Tokens erkannt – Sitzung widerrufen",
				"user_id", row.UserID, "session_id", row.SessionID)
			if err := store.RevokeSession(ctx, tx, row.SessionID, store.RevokeRefreshTokenReuse); err != nil {
				return err
			}
			return store.RecordSecurityEvent(ctx, tx, &row.UserID, store.EventRefreshTokenReuse, &row.SessionID, row.DeviceRef)
		case row.Expired || !row.SessionActive || !row.UserActive:
			return nil
		}
		if err := store.MarkRefreshTokenUsed(ctx, tx, row.TokenID, row.SessionID); err != nil {
			return err
		}
		user, err := store.FindUserByID(ctx, tx, row.UserID)
		if err != nil {
			return err
		}
		resp, err = s.issueTokens(ctx, tx, user, row.SessionID)
		return err
	})
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return nil, invalidRefreshToken()
	}
	return resp, nil
}

func (s *Auth) Logout(ctx context.Context, p Principal) error {
	err := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		if err := store.RevokeSession(ctx, tx, p.SessionID, store.RevokeLogout); err != nil {
			return err
		}
		return store.RecordSecurityEvent(ctx, tx, &p.UserID, store.EventLogout, &p.SessionID, p.DeviceRef)
	})
	if err == nil {
		s.Log.Info("Logout", "user_id", p.UserID, "session_id", p.SessionID)
	}
	return err
}

// LogoutAll widerruft alle Sitzungen des Kontos auf allen Geräten (inklusive der aktuellen).
func (s *Auth) LogoutAll(ctx context.Context, p Principal) (int64, error) {
	var n int64
	err := s.DB.Tx(ctx, func(tx pgx.Tx) error {
		var err error
		if n, err = store.RevokeAllSessions(ctx, tx, p.UserID, nil, store.RevokeLogoutAll); err != nil {
			return err
		}
		return store.RecordSecurityEvent(ctx, tx, &p.UserID, store.EventLogoutAll, &p.SessionID, p.DeviceRef)
	})
	if err == nil {
		s.Log.Info("Alle Sitzungen widerrufen", "user_id", p.UserID, "sessions", n)
	}
	return n, err
}

// ChangePassword setzt ein neues Passwort und widerruft alle anderen Sitzungen (Sicherheitsereignis).
// Die aktuelle Sitzung bleibt bestehen.
func (s *Auth) ChangePassword(ctx context.Context, p Principal, req PasswordChangeRequest) error {
	v := validate.New()
	current, _ := v.Text("currentPassword", req.CurrentPassword, validate.TextOpts{Max: PasswordMaxLength, Required: true})
	if req.NewPassword == nil {
		v.Add("newPassword", "required")
	}
	if err := v.Err(); err != nil {
		return err
	}
	user, err := store.FindUserByID(ctx, s.DB.Pool, p.UserID)
	if err != nil {
		return err
	}
	if user == nil {
		return apperr.Unauthorized()
	}
	if issue := PasswordIssue(*req.NewPassword, user.Email); issue != "" {
		return apperr.Validation([]apperr.FieldError{{Field: "newPassword", Issue: issue}})
	}
	ok, err := s.Hasher.Verify(ctx, current, user.PasswordHash)
	if err != nil {
		return err
	}
	if !ok {
		s.event(ctx, &p.UserID, store.EventPasswordChangeFailed, &p.SessionID, p.DeviceRef)
		return apperr.New(http.StatusUnauthorized, apperr.CodeInvalidCredentials, "Das aktuelle Passwort ist falsch.")
	}
	if *req.NewPassword == current {
		return apperr.Validation([]apperr.FieldError{{Field: "newPassword", Issue: "same_as_current"}})
	}
	hash, err := s.Hasher.Hash(ctx, *req.NewPassword)
	if err != nil {
		return err
	}
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		if err := store.UpdatePassword(ctx, tx, p.UserID, hash); err != nil {
			return err
		}
		n, err := store.RevokeAllSessions(ctx, tx, p.UserID, &p.SessionID, store.RevokePasswordChanged)
		if err != nil {
			return err
		}
		s.Log.Info("Passwort geändert, andere Sitzungen widerrufen", "user_id", p.UserID, "sessions", n)
		return store.RecordSecurityEvent(ctx, tx, &p.UserID, store.EventPasswordChanged, &p.SessionID, p.DeviceRef)
	})
}

// Sessions liefert die aktiven Sitzungen des Kontos.
func (s *Auth) Sessions(ctx context.Context, userID uuid.UUID, limit, offset int) ([]model.Session, int64, error) {
	return store.ListActiveSessions(ctx, s.DB.Pool, userID, limit, offset)
}

// RevokeSession beendet eine eigene Sitzung. Fremde Sitzungs-IDs verhalten sich wie unbekannte.
func (s *Auth) RevokeSession(ctx context.Context, p Principal, sessionID uuid.UUID) error {
	return s.DB.Tx(ctx, func(tx pgx.Tx) error {
		ok, err := store.RevokeOwnSession(ctx, tx, p.UserID, sessionID, store.RevokeSessionRemoved)
		if err != nil {
			return err
		}
		if !ok {
			return apperr.NotFound("Sitzung")
		}
		return store.RecordSecurityEvent(ctx, tx, &p.UserID, store.EventSessionRevoked, &sessionID, nil)
	})
}

// Authenticate prüft ein Access Token und zusätzlich, ob Sitzung und Konto noch aktiv sind
// (Logout und Sperren wirken dadurch sofort). Aktualisiert "zuletzt aktiv" höchstens minütlich.
func (s *Auth) Authenticate(ctx context.Context, token string) (*Principal, error) {
	userID, sessionID, err := s.Tokens.ParseAccessToken(token)
	if err != nil {
		return nil, nil
	}
	sess, err := store.FindActiveSession(ctx, s.DB.Pool, sessionID, userID)
	if err != nil || sess == nil {
		return nil, err
	}
	if err := store.TouchActivity(ctx, s.DB.Pool, sess.SessionID, sess.DeviceRef); err != nil {
		s.Log.Warn("Aktivitätszeitpunkt konnte nicht gespeichert werden", "error", err.Error())
	}
	return &Principal{UserID: sess.UserID, SessionID: sess.SessionID, DeviceRef: sess.DeviceRef}, nil
}

func (s *Auth) createSession(ctx context.Context, tx pgx.Tx, user *model.User, device *model.DeviceInfo, event string) (*AuthResponse, error) {
	var deviceRef *uuid.UUID
	if device != nil {
		ref, err := store.UpsertDevice(ctx, tx, user.ID, *device)
		if err != nil {
			return nil, err
		}
		deviceRef = &ref
	}
	sessionID := uuid.New()
	if err := store.CreateSession(ctx, tx, sessionID, user.ID, deviceRef, s.Cfg.SessionMaxLifetime); err != nil {
		return nil, err
	}
	if err := store.RecordSecurityEvent(ctx, tx, &user.ID, event, &sessionID, deviceRef); err != nil {
		return nil, err
	}
	return s.issueTokens(ctx, tx, user, sessionID)
}

func (s *Auth) issueTokens(ctx context.Context, tx pgx.Tx, user *model.User, sessionID uuid.UUID) (*AuthResponse, error) {
	refresh, err := security.NewRefreshToken()
	if err != nil {
		return nil, err
	}
	refreshExp, err := store.InsertRefreshToken(ctx, tx, sessionID, security.HashRefreshToken(refresh), s.Cfg.RefreshTokenTTL)
	if err != nil {
		return nil, err
	}
	access, accessExp, err := s.Tokens.IssueAccessToken(user.ID, sessionID)
	if err != nil {
		return nil, err
	}
	return &AuthResponse{
		Account: user.DTO(),
		Tokens: TokenResponse{
			TokenType:             "Bearer",
			AccessToken:           access,
			AccessTokenExpiresAt:  model.FormatTime(accessExp),
			ExpiresIn:             int64(s.Tokens.TTL() / time.Second),
			RefreshToken:          refresh,
			RefreshTokenExpiresAt: model.FormatTime(refreshExp),
			SessionID:             sessionID.String(),
		},
	}, nil
}

// event speichert ein Sicherheitsereignis außerhalb einer Transaktion. Ein Fehler beim Speichern
// darf die eigentliche Antwort (z. B. "falsches Passwort") nicht verändern, wird aber geloggt.
func (s *Auth) event(ctx context.Context, userID *uuid.UUID, eventType string, sessionID, deviceRef *uuid.UUID) {
	if err := store.RecordSecurityEvent(ctx, s.DB.Pool, userID, eventType, sessionID, deviceRef); err != nil {
		s.Log.Error("Sicherheitsereignis konnte nicht gespeichert werden", "event", eventType, "error", err.Error())
	}
}

// PasswordIssue liefert einen Fehlercode oder "" für akzeptable Passwörter.
func PasswordIssue(password, email string) string {
	n := utf8.RuneCountInString(password)
	distinct := map[rune]struct{}{}
	for _, r := range password {
		distinct[r] = struct{}{}
	}
	switch {
	case n < PasswordMinLength:
		return "too_short:min=10"
	case n > PasswordMaxLength:
		return "too_long:max=128"
	case strings.TrimSpace(password) == "":
		return "blank"
	case strings.ContainsRune(password, 0) || !utf8.ValidString(password):
		return "invalid_characters"
	case email != "" && strings.EqualFold(password, email):
		return "equals_email"
	case len(distinct) < 4:
		return "too_simple"
	}
	return ""
}

// ValidEmail normalisiert (trim, Kleinschreibung) und prüft eine E-Mail-Adresse.
func ValidEmail(v *validate.V, raw *string) string {
	if raw == nil {
		v.Add("email", "required")
		return ""
	}
	email := strings.ToLower(strings.TrimSpace(*raw))
	local, _, _ := strings.Cut(email, "@")
	if len(email) > 254 || len(local) > 64 || !emailPattern.MatchString(email) {
		v.Add("email", "invalid_email")
		return ""
	}
	return email
}

func validDevice(v *validate.V, d *DeviceRequest) *model.DeviceInfo {
	if d == nil {
		return nil
	}
	id, idOK := v.UUID("device.id", d.ID, true)
	trim := func(p *string) *string {
		if p == nil {
			return nil
		}
		t := strings.TrimSpace(*p)
		return &t
	}
	name, ok1 := v.Text("device.name", trim(d.Name), validate.TextOpts{Max: 100, SingleLine: true})
	platform, ok2 := v.Text("device.platform", trim(d.Platform), validate.TextOpts{Max: 32, SingleLine: true, Default: "ANDROID"})
	osVersion, ok3 := v.Text("device.osVersion", trim(d.OSVersion), validate.TextOpts{Max: 32, SingleLine: true})
	appVersion, ok4 := v.Text("device.appVersion", trim(d.AppVersion), validate.TextOpts{Max: 32, SingleLine: true})
	if !idOK || !ok1 || !ok2 || !ok3 || !ok4 {
		return nil
	}
	return &model.DeviceInfo{DeviceID: id, Name: name, Platform: strings.ToUpper(platform),
		OSVersion: osVersion, AppVersion: appVersion}
}

func invalidCredentials() error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeInvalidCredentials, "E-Mail-Adresse oder Passwort ist falsch.")
}

func invalidRefreshToken() error {
	return apperr.New(http.StatusUnauthorized, apperr.CodeInvalidRefreshToken,
		"Das Refresh Token ist ungültig, abgelaufen oder wurde widerrufen. Bitte erneut anmelden.")
}
