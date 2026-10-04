package security

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

const refreshPrefix = "brt_"

// Tokens gibt kurzlebige JWT Access Tokens (HS256) aus und prüft sie.
// Refresh Tokens sind 256 Bit Zufall und werden nur als SHA-256-Hash gespeichert.
type Tokens struct {
	secret   []byte
	issuer   string
	audience string
	ttl      time.Duration
	now      func() time.Time
}

func NewTokens(secret []byte, issuer, audience string, ttl time.Duration, now func() time.Time) *Tokens {
	return &Tokens{secret: secret, issuer: issuer, audience: audience, ttl: ttl, now: now}
}

func (t *Tokens) TTL() time.Duration { return t.ttl }

type accessClaims struct {
	SessionID string `json:"sid"`
	jwt.RegisteredClaims
}

// IssueAccessToken erzeugt ein Access Token für Benutzer und Sitzung.
func (t *Tokens) IssueAccessToken(userID, sessionID uuid.UUID) (string, time.Time, error) {
	now := t.now()
	exp := now.Add(t.ttl)
	claims := accessClaims{
		SessionID: sessionID.String(),
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    t.issuer,
			Audience:  jwt.ClaimStrings{t.audience},
			Subject:   userID.String(),
			ID:        uuid.NewString(),
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(t.secret)
	return signed, exp, err
}

var ErrInvalidToken = errors.New("ungültiges Token")

// ParseAccessToken prüft Signatur (nur HS256), Aussteller, Zielgruppe und Gültigkeit.
// Die Prüfung erfolgt gegen die echte Uhr.
func (t *Tokens) ParseAccessToken(raw string) (userID, sessionID uuid.UUID, err error) {
	claims := &accessClaims{}
	_, err = jwt.ParseWithClaims(raw, claims, func(*jwt.Token) (any, error) { return t.secret, nil },
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithIssuer(t.issuer),
		jwt.WithAudience(t.audience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(5*time.Second),
	)
	if err != nil {
		return uuid.Nil, uuid.Nil, ErrInvalidToken
	}
	userID, err1 := uuid.Parse(claims.Subject)
	sessionID, err2 := uuid.Parse(claims.SessionID)
	if err1 != nil || err2 != nil {
		return uuid.Nil, uuid.Nil, ErrInvalidToken
	}
	return userID, sessionID, nil
}

// NewRefreshToken erzeugt ein neues Refresh Token (Präfix "brt_" erleichtert Secret-Scanning).
func NewRefreshToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return refreshPrefix + base64.RawURLEncoding.EncodeToString(b), nil
}

// HashRefreshToken liefert den SHA-256-Hash oder nil für offensichtlich fremde Werte.
func HashRefreshToken(token string) []byte {
	if len(token) != len(refreshPrefix)+43 || token[:len(refreshPrefix)] != refreshPrefix {
		return nil
	}
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
