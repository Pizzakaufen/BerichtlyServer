// Package validate sammelt Validierungsfehler feldweise.
package validate

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"berichtly-server/internal/apperr"
	"berichtly-server/internal/model"
)

type V struct {
	errs []apperr.FieldError
}

func New() *V { return &V{} }

func (v *V) Add(field, issue string) {
	v.errs = append(v.errs, apperr.FieldError{Field: field, Issue: issue})
}

func (v *V) Check(ok bool, field, issue string) {
	if !ok {
		v.Add(field, issue)
	}
}

func (v *V) OK() bool { return len(v.errs) == 0 }

// Err liefert einen Validierungsfehler oder nil.
func (v *V) Err() error {
	if v.OK() {
		return nil
	}
	return apperr.Validation(v.errs)
}

func (v *V) Errors() []apperr.FieldError { return v.errs }

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// ParseUUID akzeptiert nur die kanonische Schreibweise mit Bindestrichen.
func ParseUUID(s string) (uuid.UUID, bool) {
	if !uuidPattern.MatchString(s) {
		return uuid.Nil, false
	}
	id, err := uuid.Parse(s)
	return id, err == nil
}

func (v *V) UUID(field string, value *string, required bool) (uuid.UUID, bool) {
	if value == nil {
		if required {
			v.Add(field, "required")
		}
		return uuid.Nil, false
	}
	id, ok := ParseUUID(*value)
	if !ok {
		v.Add(field, "invalid_uuid")
	}
	return id, ok
}

func (v *V) Date(field string, value *string, required bool) (*model.Date, bool) {
	if value == nil {
		if required {
			v.Add(field, "required")
			return nil, false
		}
		return nil, true
	}
	d, ok := model.ParseDate(*value)
	if !ok {
		v.Add(field, "invalid_date")
		return nil, false
	}
	if !d.InRange() {
		v.Add(field, "out_of_range")
		return nil, false
	}
	return &d, true
}

func (v *V) Timestamp(field string, value *string) (*time.Time, bool) {
	if value == nil {
		return nil, true
	}
	t, err := time.Parse(time.RFC3339Nano, *value)
	if err != nil {
		v.Add(field, "invalid_timestamp")
		return nil, false
	}
	t = t.UTC().Truncate(time.Millisecond)
	return &t, true
}

// TextOpts steuert die Prüfung eines Textfelds.
type TextOpts struct {
	Max        int
	Required   bool
	NotBlank   bool
	SingleLine bool
	Default    string
}

// Text prüft Länge (in Zeichen), NUL-Zeichen und bei einzeiligen Feldern Steuerzeichen.
func (v *V) Text(field string, value *string, o TextOpts) (string, bool) {
	if value == nil {
		if o.Required {
			v.Add(field, "required")
			return "", false
		}
		return o.Default, true
	}
	s := *value
	switch {
	case !utf8.ValidString(s):
		v.Add(field, "invalid_characters")
	case utf8.RuneCountInString(s) > o.Max:
		v.Add(field, fmt.Sprintf("too_long:max=%d", o.Max))
	case o.NotBlank && strings.TrimSpace(s) == "":
		v.Add(field, "blank")
	case strings.ContainsRune(s, 0):
		v.Add(field, "invalid_characters")
	case o.SingleLine && strings.IndexFunc(s, unicode.IsControl) >= 0:
		v.Add(field, "invalid_characters")
	default:
		return s, true
	}
	return "", false
}

func (v *V) Int(field string, value *int, min, max, def int, required bool) (int, bool) {
	if value == nil {
		if required {
			v.Add(field, "required")
			return 0, false
		}
		return def, true
	}
	if *value < min || *value > max {
		v.Add(field, fmt.Sprintf("out_of_range:%d..%d", min, max))
		return 0, false
	}
	return *value, true
}

// Enum prüft, dass der Wert einer der erlaubten Werte ist.
func (v *V) Enum(field string, value *string, allowed []string, def string) (string, bool) {
	if value == nil {
		return def, true
	}
	if !slices.Contains(allowed, *value) {
		v.Add(field, "invalid_value:"+strings.Join(allowed, "|"))
		return "", false
	}
	return *value, true
}

// Timezone akzeptiert nur IANA-Zonen der Form Region/Ort (z. B. Europe/Berlin).
func (v *V) Timezone(field string, value *string) (*time.Location, bool) {
	if value == nil {
		return nil, true
	}
	if !strings.Contains(*value, "/") || strings.Contains(*value, "..") {
		v.Add(field, "invalid_timezone")
		return nil, false
	}
	loc, err := time.LoadLocation(*value)
	if err != nil {
		v.Add(field, "invalid_timezone")
		return nil, false
	}
	return loc, true
}
