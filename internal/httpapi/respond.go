// Package httpapi stellt die versionierte REST-API (/api/v1) bereit.
package httpapi

import (
	"encoding/json"
	"errors"
	"log/slog"
	"mime"
	"net/http"
	"strconv"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/validate"

	"github.com/google/uuid"
)

// envelope ist die einheitliche Hülle erfolgreicher Antworten: {"data": ..., "meta": ...}.
type envelope struct {
	Data any       `json:"data"`
	Meta *pageMeta `json:"meta,omitempty"`
}

type pageMeta struct {
	Page    int   `json:"page"`
	Limit   int   `json:"limit"`
	Total   int64 `json:"total"`
	HasMore bool  `json:"hasMore"`
}

type errorBody struct {
	Error errorPayload `json:"error"`
}

type errorPayload struct {
	Code      string               `json:"code"`
	Message   string               `json:"message"`
	RequestID string               `json:"requestId"`
	Details   []apperr.FieldError  `json:"details"`
	Conflict  *apperr.ConflictInfo `json:"conflict"`
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeData(w http.ResponseWriter, status int, data any) {
	writeJSON(w, status, envelope{Data: data})
}

func writePage(w http.ResponseWriter, data any, p page, total int64) {
	writeJSON(w, http.StatusOK, envelope{Data: data, Meta: &pageMeta{
		Page: p.page, Limit: p.limit, Total: total, HasMore: int64(p.offset()+p.limit) < total,
	}})
}

// writeError übersetzt Fehler in die einheitliche Fehlerstruktur. Interne Fehler werden geloggt,
// aber niemals mit Details an den Client gesendet.
func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var e *apperr.Error
	if !errors.As(err, &e) {
		logger(r).Error("Unbehandelter Fehler", "method", r.Method, "path", r.URL.Path, "error", err.Error())
		metricsFrom(r).unhandledError()
		e = apperr.New(http.StatusInternalServerError, apperr.CodeInternalError,
			"Interner Serverfehler. Bitte später erneut versuchen.")
	}
	writeJSON(w, e.Status, errorBody{errorPayload{
		Code: e.Code, Message: e.Message, RequestID: requestID(r), Details: e.Details, Conflict: e.Conflict,
	}})
}

// decodeJSON liest einen JSON-Body mit Größenbegrenzung. Unbekannte Felder werden ignoriert,
// damit neuere App-Versionen mit älteren Servern funktionieren.
func decodeJSON(w http.ResponseWriter, r *http.Request, maxBytes int64, dst any) error {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		return apperr.New(http.StatusUnsupportedMediaType, apperr.CodeUnsupportedMediaType,
			"Nicht unterstützter Content-Type. Erwartet wird application/json.")
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return apperr.New(http.StatusRequestEntityTooLarge, apperr.CodePayloadTooLarge, "Die Anfrage ist zu groß.")
		}
		return invalidBody()
	}
	if dec.More() {
		return invalidBody()
	}
	return nil
}

func invalidBody() error {
	return apperr.New(http.StatusBadRequest, apperr.CodeInvalidRequestBody,
		"Der Request-Body ist kein gültiges JSON oder hat eine falsche Struktur.")
}

// ---------------------------------------------------------------------------
// Query- und Pfadparameter
// ---------------------------------------------------------------------------

type page struct{ page, limit int }

func (p page) offset() int { return (p.page - 1) * p.limit }

func pageParams(r *http.Request) (page, error) {
	p, err := queryInt(r, "page", 1, 1, 100000)
	if err != nil {
		return page{}, err
	}
	l, err := queryInt(r, "limit", 50, 1, 100)
	return page{p, l}, err
}

func queryInt(r *http.Request, name string, def, min, max int) (int, error) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil {
		return 0, apperr.BadParameter(name, "not_an_integer")
	}
	if v < min || v > max {
		return 0, apperr.BadParameter(name, "out_of_range:"+strconv.Itoa(min)+".."+strconv.Itoa(max))
	}
	return v, nil
}

func pathUUID(r *http.Request, name string) (uuid.UUID, error) {
	id, ok := validate.ParseUUID(r.PathValue(name))
	if !ok {
		return uuid.Nil, apperr.BadParameter(name, "invalid_uuid")
	}
	return id, nil
}

func logger(r *http.Request) *slog.Logger {
	if l, ok := r.Context().Value(ctxLogger).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}
