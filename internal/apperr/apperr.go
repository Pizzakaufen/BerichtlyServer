// Package apperr definiert fachliche Fehler mit stabilen, maschinenlesbaren Fehlercodes.
// Die HTTP-Schicht übersetzt sie in einheitliche JSON-Fehlerantworten.
package apperr

import (
	"fmt"
	"net/http"
)

// Fehlercodes (stabil, Teil der API).
const (
	CodeValidationFailed         = "VALIDATION_FAILED"
	CodeInvalidRequestBody       = "INVALID_REQUEST_BODY"
	CodeInvalidParameter         = "INVALID_PARAMETER"
	CodeUnauthorized             = "UNAUTHORIZED"
	CodeInvalidCredentials       = "INVALID_CREDENTIALS"
	CodeInvalidRefreshToken      = "INVALID_REFRESH_TOKEN"
	CodeAccountDisabled          = "ACCOUNT_DISABLED"
	CodeAccountTemporarilyLocked = "ACCOUNT_TEMPORARILY_LOCKED"
	CodeRegistrationDisabled     = "REGISTRATION_DISABLED"
	CodeEmailAlreadyRegistered   = "EMAIL_ALREADY_REGISTERED"
	CodeNotFound                 = "NOT_FOUND"
	CodeMethodNotAllowed         = "METHOD_NOT_ALLOWED"
	CodeConflict                 = "CONFLICT"
	CodePayloadTooLarge          = "PAYLOAD_TOO_LARGE"
	CodeUnsupportedMediaType     = "UNSUPPORTED_MEDIA_TYPE"
	CodeRateLimited              = "RATE_LIMITED"
	CodeInternalError            = "INTERNAL_ERROR"
)

// ConflictReason beschreibt, warum eine Änderung nicht übernommen wurde.
type ConflictReason string

const (
	// Der Datensatz wurde seit der Basisversion des Clients auf dem Server geändert.
	ReasonVersionMismatch ConflictReason = "VERSION_MISMATCH"
	// Der Datensatz wurde auf dem Server gelöscht.
	ReasonDeletedOnServer ConflictReason = "DELETED_ON_SERVER"
	// Ein Datensatz mit dieser ID existiert bereits mit anderem Inhalt.
	ReasonAlreadyExists ConflictReason = "ALREADY_EXISTS"
	// Für diese Woche existiert bereits ein anderer Wochenbericht.
	ReasonDuplicateWeek ConflictReason = "DUPLICATE_WEEK"
	// Die ID ist vergeben (z. B. von einem anderen Konto) und kann nicht verwendet werden.
	ReasonIDUnavailable ConflictReason = "ID_UNAVAILABLE"
)

type FieldError struct {
	Field string `json:"field"`
	Issue string `json:"issue"`
}

// ConflictInfo enthält den aktuellen Serverstand. Der Server überschreibt bei Konflikten nichts.
type ConflictInfo struct {
	Reason        ConflictReason `json:"reason"`
	ServerVersion *int           `json:"serverVersion"`
	ServerRecord  any            `json:"serverRecord"`
}

// Error ist ein fachlicher Fehler mit HTTP-Status.
type Error struct {
	Status   int
	Code     string
	Message  string
	Details  []FieldError
	Conflict *ConflictInfo
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

func New(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

func Validation(details []FieldError) *Error {
	return &Error{Status: http.StatusUnprocessableEntity, Code: CodeValidationFailed,
		Message: "Die Eingabedaten sind ungültig.", Details: details}
}

func BadParameter(field, issue string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: CodeInvalidParameter, Message: "Ungültiger Parameter.",
		Details: []FieldError{{field, issue}}}
}

func NotFound(what string) *Error {
	return New(http.StatusNotFound, CodeNotFound, what+" wurde nicht gefunden.")
}

func Conflict(info ConflictInfo) *Error {
	return &Error{Status: http.StatusConflict, Code: CodeConflict,
		Message: "Der Datensatz wurde zwischenzeitlich geändert. Es wurde nichts überschrieben.", Conflict: &info}
}

func Unauthorized() *Error {
	return New(http.StatusUnauthorized, CodeUnauthorized,
		"Authentifizierung erforderlich oder Access Token ungültig/abgelaufen.")
}
