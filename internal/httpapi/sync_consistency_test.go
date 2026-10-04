package httpapi_test

import (
	"fmt"
	"sync"
	"testing"

	"github.com/google/uuid"
)

// Während ein Gerät fortlaufend Änderungen abruft, schreiben zwei andere Geräte gleichzeitig
// Tages- und Wochenberichte. Am Ende muss der abrufende Client jede einzelne Änderung gesehen
// haben – kein Cursor darf über eine noch nicht sichtbare Änderung hinwegspringen.
func TestPullVerliertKeineAenderungenBeiGleichzeitigenSchreibvorgaengen(t *testing.T) {
	e := newEnv(t)
	tok := e.register("").access

	const perWriter = 60
	var wg sync.WaitGroup
	written := sync.Map{}
	for w := 0; w < 2; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				id := uuid.NewString()
				var r *response
				if i%2 == 0 {
					r = e.post("/api/v1/daily-reports", tok, map[string]any{"id": id, "date": "2026-10-05", "text": fmt.Sprintf("w%d-%d", w, i)})
				} else {
					// Jede Woche nur einmal: Wochen über mehrere Jahre verteilen.
					monday := mondayAfter(w*perWriter + i)
					r = e.post("/api/v1/weekly-reports", tok, map[string]any{"id": id, "weekStart": monday, "content": "x"})
				}
				if r.Status == 201 {
					written.Store(id, true)
				}
			}
		}(w)
	}

	seen := map[string]bool{}
	cursor := "0"
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	pull := func() bool {
		p := e.get("/api/v1/sync/changes?limit=7&cursor="+cursor, tok).expect(200)
		for _, c := range p.list("data", "changes") {
			seen[field(c, "id").(string)] = true
		}
		cursor = p.str("data", "nextCursor")
		return p.at("data", "hasMore") == true
	}
	for running := true; running; {
		select {
		case <-done:
			running = false
		default:
			pull()
		}
	}
	for pull() {
	}

	missing := 0
	written.Range(func(k, _ any) bool {
		if !seen[k.(string)] {
			missing++
		}
		return true
	})
	if missing > 0 {
		t.Fatalf("%d Änderungen wurden beim Abruf übersprungen", missing)
	}
}

// mondayAfter liefert den n-ten Montag ab 2000-01-03 (YYYY-MM-DD).
func mondayAfter(n int) string {
	y, m, d := 2000, 1, 3
	days := d + n*7
	for {
		dim := daysIn(y, m)
		if days <= dim {
			break
		}
		days -= dim
		m++
		if m > 12 {
			m, y = 1, y+1
		}
	}
	return fmt.Sprintf("%04d-%02d-%02d", y, m, days)
}

func daysIn(y, m int) int {
	switch m {
	case 2:
		if y%4 == 0 && (y%100 != 0 || y%400 == 0) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}
