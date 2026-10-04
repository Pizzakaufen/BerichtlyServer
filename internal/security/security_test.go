package security

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestArgon2idHashIstGesalzenUndVerifizierbar(t *testing.T) {
	h := NewPasswordHasher()
	ctx := context.Background()
	a, _ := h.Hash(ctx, "geheimes-Passwort-1")
	b, _ := h.Hash(ctx, "geheimes-Passwort-1")
	if a == b || !strings.HasPrefix(a, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatal(a, b)
	}
	if ok, _ := h.Verify(ctx, "geheimes-Passwort-1", a); !ok {
		t.Fatal("richtiges Passwort abgelehnt")
	}
	if ok, _ := h.Verify(ctx, "geheimes-Passwort-2", a); ok {
		t.Fatal("falsches Passwort akzeptiert")
	}
	if ok, _ := h.Verify(ctx, "x", "kein-hash"); ok {
		t.Fatal("ungültiger Hash akzeptiert")
	}
	if h.NeedsRehash(a) {
		t.Fatal("aktueller Hash als veraltet erkannt")
	}
	stronger := NewPasswordHasher()
	stronger.Memory = 64 * 1024
	if !stronger.NeedsRehash(a) {
		t.Fatal("schwächerer Hash nicht erkannt")
	}
}

func TestAccessTokens(t *testing.T) {
	secret := []byte("0123456789abcdefghijklmnopqrstuvwxyz")
	tok := NewTokens(secret, "iss", "aud", 15*time.Minute, time.Now)
	user, sess := uuid.New(), uuid.New()
	raw, _, err := tok.IssueAccessToken(user, sess)
	if err != nil {
		t.Fatal(err)
	}
	u, s, err := tok.ParseAccessToken(raw)
	if err != nil || u != user || s != sess {
		t.Fatal(err)
	}
	other := NewTokens(secret, "iss", "andere-app", 15*time.Minute, time.Now)
	if _, _, err := other.ParseAccessToken(raw); err == nil {
		t.Fatal("falsche Zielgruppe akzeptiert")
	}
	old := NewTokens(secret, "iss", "aud", 15*time.Minute, func() time.Time { return time.Now().Add(-time.Hour) })
	expired, _, _ := old.IssueAccessToken(user, sess)
	if _, _, err := tok.ParseAccessToken(expired); err == nil {
		t.Fatal("abgelaufenes Token akzeptiert")
	}
}

func TestRefreshTokens(t *testing.T) {
	a, _ := NewRefreshToken()
	b, _ := NewRefreshToken()
	if a == b || !strings.HasPrefix(a, "brt_") || HashRefreshToken(a) == nil {
		t.Fatal(a, b)
	}
	if HashRefreshToken("brt_kurz") != nil || HashRefreshToken(strings.Repeat("x", 47)) != nil {
		t.Fatal("fremdes Format akzeptiert")
	}
}
