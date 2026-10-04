// Package model enthält die Domänentypen und ihre JSON-Darstellung für die API.
package model

import (
	"encoding/json"
	"fmt"
	"time"
)

// Date ist ein reines Kalenderdatum ohne Uhrzeit und Zeitzone (z. B. der Arbeitstag eines
// Berichts). Es wird in der Zeitzone des Benutzers interpretiert, nie in der des Servers.
type Date struct {
	Year  int
	Month time.Month
	Day   int
}

// MinDate und MaxDate begrenzen Berichtsdaten auf einen sinnvollen Bereich.
var (
	MinDate = Date{2000, time.January, 1}
	MaxDate = Date{2100, time.December, 31}
)

func DateOf(t time.Time) Date {
	y, m, d := t.Date()
	return Date{y, m, d}
}

// ParseDate akzeptiert ausschließlich das Format YYYY-MM-DD mit gültigem Kalenderdatum.
func ParseDate(s string) (Date, bool) {
	if len(s) != 10 {
		return Date{}, false
	}
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		return Date{}, false
	}
	return DateOf(t), true
}

// Time liefert Mitternacht UTC (für die Datenbank).
func (d Date) Time() time.Time { return time.Date(d.Year, d.Month, d.Day, 0, 0, 0, 0, time.UTC) }

func (d Date) String() string { return fmt.Sprintf("%04d-%02d-%02d", d.Year, int(d.Month), d.Day) }

func (d Date) AddDays(n int) Date { return DateOf(d.Time().AddDate(0, 0, n)) }

func (d Date) Weekday() time.Weekday { return d.Time().Weekday() }

func (d Date) Before(o Date) bool { return d.Time().Before(o.Time()) }

func (d Date) InRange() bool { return !d.Before(MinDate) && !MaxDate.Before(d) }

func (d Date) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

// IsoWeek ist eine ISO-Woche von Montag bis Sonntag.
type IsoWeek struct {
	Start Date
}

// WeekContaining liefert die Woche (Montag–Sonntag), die das Datum enthält.
func WeekContaining(d Date) IsoWeek {
	offset := (int(d.Weekday()) + 6) % 7 // Montag = 0 … Sonntag = 6
	return IsoWeek{Start: d.AddDays(-offset)}
}

func (w IsoWeek) End() Date { return w.Start.AddDays(6) }

func (w IsoWeek) ISO() (year, week int) { return w.Start.Time().ISOWeek() }

func (w IsoWeek) Days() []Date {
	days := make([]Date, 7)
	for i := range days {
		days[i] = w.Start.AddDays(i)
	}
	return days
}

// FormatTime gibt Zeitpunkte einheitlich als UTC im ISO-8601-Format mit Millisekunden aus.
func FormatTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// FormatTimePtr wie FormatTime, nil bleibt nil.
func FormatTimePtr(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := FormatTime(*t)
	return &s
}
