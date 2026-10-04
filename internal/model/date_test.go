package model

import "testing"

func TestWocheBeginntImmerAmMontag(t *testing.T) {
	sunday, _ := ParseDate("2026-10-11")
	w := WeekContaining(sunday)
	if w.Start.String() != "2026-10-05" || w.End().String() != "2026-10-11" || len(w.Days()) != 7 {
		t.Fatal(w.Start, w.End())
	}
	monday, _ := ParseDate("2026-10-05")
	if WeekContaining(monday) != w {
		t.Fatal("Montag gehört zur selben Woche")
	}
	d, _ := ParseDate("2027-01-03")
	if y, n := WeekContaining(d).ISO(); y != 2026 || n != 53 {
		t.Fatal(y, n)
	}
	d, _ = ParseDate("2027-01-04")
	if _, n := WeekContaining(d).ISO(); n != 1 {
		t.Fatal(n)
	}
}

func TestDatumParsen(t *testing.T) {
	for _, bad := range []string{"2026-02-30", "05.10.2026", "2026-1-5", "", "2026-10-05T00:00:00Z"} {
		if _, ok := ParseDate(bad); ok {
			t.Fatalf("%q akzeptiert", bad)
		}
	}
	if d, ok := ParseDate("2024-02-29"); !ok || !d.InRange() {
		t.Fatal("Schalttag abgelehnt")
	}
	if d, _ := ParseDate("1999-12-31"); d.InRange() {
		t.Fatal("Datum außerhalb des Bereichs akzeptiert")
	}
}

func TestIsoWocheAusJahrUndNummer(t *testing.T) {
	cases := []struct {
		year, week int
		start      string
		ok         bool
	}{
		{2026, 1, "2025-12-29", true},
		{2026, 53, "2026-12-28", true}, // 2026 beginnt an einem Donnerstag → 53 Wochen
		{2025, 53, "", false},
		{2020, 53, "2020-12-28", true},
		{2021, 1, "2021-01-04", true},
		{2026, 0, "", false},
		{1999, 10, "", false},
	}
	for _, c := range cases {
		w, ok := IsoWeekOf(c.year, c.week)
		if ok != c.ok || (ok && w.Start.String() != c.start) {
			t.Fatalf("%d/%d: %v %v", c.year, c.week, w.Start, ok)
		}
	}
	first, last := MonthRange(2024, 2)
	if first.String() != "2024-02-01" || last.String() != "2024-02-29" {
		t.Fatal(first, last)
	}
	_, last = MonthRange(2026, 12)
	if last.String() != "2026-12-31" {
		t.Fatal(last)
	}
}
