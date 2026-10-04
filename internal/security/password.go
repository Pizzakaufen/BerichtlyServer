// Package security enthält Passwort-Hashing (Argon2id) und Token-Erzeugung/-Prüfung.
package security

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/crypto/argon2"
)

// PasswordHasher erzeugt und prüft Argon2id-Hashes im PHC-Format:
// $argon2id$v=19$m=<KiB>,t=<Iterationen>,p=<Parallelität>$<salt>$<hash>
//
// Standardparameter nach OWASP-Empfehlung (m=19 MiB, t=2, p=1). Die Zahl gleichzeitiger
// Berechnungen ist begrenzt, damit Login-Spitzen auf kleinen Servern den Speicher nicht erschöpfen.
type PasswordHasher struct {
	Memory      uint32
	Iterations  uint32
	Parallelism uint8
	sem         chan struct{}

	dummyOnce sync.Once
	dummy     string
}

const (
	saltBytes = 16
	hashBytes = 32
)

func NewPasswordHasher() *PasswordHasher {
	return &PasswordHasher{Memory: 19 * 1024, Iterations: 2, Parallelism: 1, sem: make(chan struct{}, 4)}
}

func (h *PasswordHasher) acquire(ctx context.Context) error {
	select {
	case h.sem <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *PasswordHasher) release() { <-h.sem }

// Hash erzeugt einen neuen, gesalzenen Hash.
func (h *PasswordHasher) Hash(ctx context.Context, password string) (string, error) {
	if err := h.acquire(ctx); err != nil {
		return "", err
	}
	defer h.release()
	return h.hash(password)
}

func (h *PasswordHasher) hash(password string) (string, error) {
	salt := make([]byte, saltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, h.Iterations, h.Memory, h.Parallelism, hashBytes)
	enc := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		h.Memory, h.Iterations, h.Parallelism, enc.EncodeToString(salt), enc.EncodeToString(key)), nil
}

// Verify prüft ein Passwort in konstanter Zeit gegen einen gespeicherten Hash.
func (h *PasswordHasher) Verify(ctx context.Context, password, encoded string) (bool, error) {
	p, ok := parsePHC(encoded)
	if !ok {
		return false, nil
	}
	if err := h.acquire(ctx); err != nil {
		return false, err
	}
	defer h.release()
	key := argon2.IDKey([]byte(password), p.salt, p.t, p.m, p.p, uint32(len(p.hash)))
	return subtle.ConstantTimeCompare(key, p.hash) == 1, nil
}

// VerifyDummy rechnet einen Hash gegen einen festen Dummy, damit Logins mit unbekannter E-Mail
// genauso lange dauern wie mit bekannter (Schutz vor Konto-Enumeration über Antwortzeiten).
func (h *PasswordHasher) VerifyDummy(ctx context.Context, password string) {
	h.dummyOnce.Do(func() { h.dummy, _ = h.hash("berichtly-timing-equalizer") })
	_, _ = h.Verify(ctx, password, h.dummy)
}

// NeedsRehash ist true, wenn der Hash mit schwächeren als den aktuellen Parametern erzeugt wurde.
func (h *PasswordHasher) NeedsRehash(encoded string) bool {
	p, ok := parsePHC(encoded)
	return !ok || p.m < h.Memory || p.t < h.Iterations || p.p < h.Parallelism
}

type phc struct {
	m, t       uint32
	p          uint8
	salt, hash []byte
}

func parsePHC(encoded string) (phc, bool) {
	parts := strings.Split(encoded, "$")
	// ["", "argon2id", "v=19", "m=..,t=..,p=..", salt, hash]
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return phc{}, false
	}
	var r phc
	for _, kv := range strings.Split(parts[3], ",") {
		k, v, ok := strings.Cut(kv, "=")
		n, err := strconv.ParseUint(v, 10, 32)
		if !ok || err != nil {
			return phc{}, false
		}
		switch k {
		case "m":
			r.m = uint32(n)
		case "t":
			r.t = uint32(n)
		case "p":
			if n > 255 {
				return phc{}, false
			}
			r.p = uint8(n)
		default:
			return phc{}, false
		}
	}
	if r.m < 8 || r.m > 4*1024*1024 || r.t < 1 || r.t > 64 || r.p < 1 {
		return phc{}, false
	}
	var err error
	if r.salt, err = base64.RawStdEncoding.DecodeString(parts[4]); err != nil || len(r.salt) < 8 {
		return phc{}, false
	}
	if r.hash, err = base64.RawStdEncoding.DecodeString(parts[5]); err != nil || len(r.hash) < 16 {
		return phc{}, false
	}
	return r, true
}
