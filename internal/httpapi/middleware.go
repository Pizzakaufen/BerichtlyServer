package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net"
	"net/http"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/service"
)

type ctxKey int

const (
	ctxRequestID ctxKey = iota
	ctxLogger
	ctxPrincipal
	ctxMetrics
	ctxRequestInfo
)

// requestInfo wird nach der Authentifizierung ergänzt, damit das Request-Log die Benutzer-ID enthält.
type requestInfo struct{ userID string }

const requestIDHeader = "X-Request-ID"

func requestID(r *http.Request) string {
	id, _ := r.Context().Value(ctxRequestID).(string)
	return id
}

func validRequestID(id string) bool {
	if len(id) < 8 || len(id) > 64 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return false
		}
	}
	return true
}

// statusRecorder merkt sich den HTTP-Status für Logging und Metriken.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// observe vergibt die Request-ID, misst, loggt und fängt Panics ab.
// Geloggt werden nur Methode, Pfad, Status und Dauer – keine Header, Query-Werte oder Bodies.
func (a *API) observe(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		id := r.Header.Get(requestIDHeader)
		if !validRequestID(id) {
			id = uuid.NewString()
		}
		w.Header().Set(requestIDHeader, id)
		log := a.log.With("request_id", id)
		ctx := context.WithValue(r.Context(), ctxRequestID, id)
		ctx = context.WithValue(ctx, ctxLogger, log)
		ctx = context.WithValue(ctx, ctxMetrics, a.metrics)
		info := &requestInfo{}
		ctx = context.WithValue(ctx, ctxRequestInfo, info)
		r = r.WithContext(ctx)
		rec := &statusRecorder{ResponseWriter: w}

		defer func() {
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				log.Error("Panic im Handler", "panic", p, "stack", string(debug.Stack()))
				a.metrics.unhandledError()
				if rec.status == 0 {
					writeError(rec, r, apperr.New(http.StatusInternalServerError, apperr.CodeInternalError,
						"Interner Serverfehler. Bitte später erneut versuchen."))
				}
			}
			a.metrics.record(rec.status)
			if r.URL.Path != "/api/v1/health/live" {
				attrs := []any{"method", r.Method, "path", r.URL.Path, "status", rec.status,
					"duration_ms", time.Since(start).Milliseconds()}
				if info.userID != "" {
					attrs = append(attrs, "user_id", info.userID)
				}
				log.Info("request", attrs...)
			}
		}()
		next.ServeHTTP(rec, r)
	})
}

// securityHeaders setzt Schutz-Header; API-Antworten dürfen nicht zwischengespeichert werden.
// HSTS wird nur gesetzt, wenn ein vertrauenswürdiger Reverse Proxy HTTPS meldet.
func (a *API) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Resource-Policy", "same-origin")
		if strings.HasPrefix(r.URL.Path, "/api/v") || strings.HasPrefix(r.URL.Path, "/internal/") {
			h.Set("Cache-Control", "no-store")
			h.Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		}
		if a.cfg.Server.TrustProxy && r.Header.Get("X-Forwarded-Proto") == "https" {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// cors ist nur aktiv, wenn Origins konfiguriert sind (die Android-App benötigt kein CORS).
func (a *API) cors(next http.Handler) http.Handler {
	origins := a.cfg.CORS.AllowedOrigins
	if len(origins) == 0 {
		return next
	}
	wildcard := slices.Contains(origins, "*")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (wildcard || slices.Contains(origins, origin)) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Expose-Headers", requestIDHeader)
			if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
				h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, "+requestIDHeader)
				h.Set("Access-Control-Max-Age", "600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

// clientIP liefert die Client-IP. Hinter einem vertrauenswürdigen Reverse Proxy (TRUST_PROXY=true)
// wird der letzte Eintrag von X-Forwarded-For verwendet – den setzt der Proxy selbst.
func (a *API) clientIP(r *http.Request) string {
	if a.cfg.Server.TrustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[len(parts)-1]); net.ParseIP(ip) != nil {
				return ip
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// rateLimit begrenzt Anfragen pro Client-IP.
func (a *API) rateLimit(l *limiter, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ok, retry := l.allow(a.clientIP(r)); !ok {
			writeRateLimited(w, r, retry)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// authenticated prüft das Access Token und legt den Principal in den Kontext.
func (a *API) authenticated(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		var p *service.Principal
		var err error
		if ok && token != "" {
			p, err = a.auth.Authenticate(r.Context(), strings.TrimSpace(token))
			if err != nil {
				writeError(w, r, err)
				return
			}
		}
		if p == nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="berichtly"`)
			writeError(w, r, apperr.Unauthorized())
			return
		}
		if info, ok := r.Context().Value(ctxRequestInfo).(*requestInfo); ok {
			info.userID = p.UserID.String()
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxPrincipal, *p)))
	}
}

func principal(r *http.Request) service.Principal {
	return r.Context().Value(ctxPrincipal).(service.Principal)
}

// ---------------------------------------------------------------------------
// Rate Limiter (Token Bucket pro Schlüssel, ohne Hintergrund-Goroutine)
// ---------------------------------------------------------------------------

type bucket struct {
	tokens float64
	last   time.Time
}

type limiter struct {
	mu          sync.Mutex
	perMinute   float64
	buckets     map[string]*bucket
	lastCleanup time.Time
}

func newLimiter(perMinute int) *limiter {
	return &limiter{perMinute: float64(perMinute), buckets: map[string]*bucket{}, lastCleanup: time.Now()}
}

// allow verbraucht ein Token; bei Ablehnung wird die Wartezeit in Sekunden geliefert.
func (l *limiter) allow(key string) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if now.Sub(l.lastCleanup) > time.Minute {
		for k, b := range l.buckets {
			if now.Sub(b.last) > 10*time.Minute {
				delete(l.buckets, k)
			}
		}
		l.lastCleanup = now
	}
	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.perMinute, last: now}
		l.buckets[key] = b
	}
	b.tokens = math.Min(l.perMinute, b.tokens+now.Sub(b.last).Minutes()*l.perMinute)
	b.last = now
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	wait := (1 - b.tokens) / l.perMinute * 60
	return false, int(math.Ceil(wait))
}

// ---------------------------------------------------------------------------
// Metriken (Grundlage für späteres Monitoring)
// ---------------------------------------------------------------------------

type metrics struct {
	started                                time.Time
	total, s2xx, s3xx, s4xx, s5xx, limited atomic.Int64
	unhandled                              atomic.Int64
}

func (m *metrics) record(status int) {
	m.total.Add(1)
	switch {
	case status >= 500:
		m.s5xx.Add(1)
	case status == http.StatusTooManyRequests:
		m.s4xx.Add(1)
		m.limited.Add(1)
	case status >= 400:
		m.s4xx.Add(1)
	case status >= 300:
		m.s3xx.Add(1)
	default:
		m.s2xx.Add(1)
	}
}

func (m *metrics) unhandledError() {
	if m != nil {
		m.unhandled.Add(1)
	}
}

func metricsFrom(r *http.Request) *metrics {
	m, _ := r.Context().Value(ctxMetrics).(*metrics)
	return m
}

type metricsSnapshot struct {
	RequestsTotal   int64 `json:"requestsTotal"`
	Responses2xx    int64 `json:"responses2xx"`
	Responses3xx    int64 `json:"responses3xx"`
	Responses4xx    int64 `json:"responses4xx"`
	Responses5xx    int64 `json:"responses5xx"`
	RateLimited     int64 `json:"rateLimited"`
	UnhandledErrors int64 `json:"unhandledErrors"`
}

func (m *metrics) snapshot() metricsSnapshot {
	return metricsSnapshot{m.total.Load(), m.s2xx.Load(), m.s3xx.Load(), m.s4xx.Load(), m.s5xx.Load(),
		m.limited.Load(), m.unhandled.Load()}
}

// writeRateLimited antwortet mit 429 und Retry-After (Sekunden bis zur nächsten erlaubten Anfrage).
func writeRateLimited(w http.ResponseWriter, r *http.Request, retryAfter int) {
	w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	writeError(w, r, apperr.New(http.StatusTooManyRequests, apperr.CodeRateLimited,
		"Zu viele Anfragen. Bitte kurz warten und erneut versuchen."))
}

// hashKey bildet einen Schlüssel für das Rate Limiting, ohne den Klartext im Speicher zu halten.
func hashKey(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:16])
}
