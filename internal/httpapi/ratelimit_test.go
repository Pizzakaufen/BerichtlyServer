package httpapi

import "testing"

func TestTokenBucketProSchluessel(t *testing.T) {
	l := newLimiter(3)
	for i := 0; i < 3; i++ {
		if ok, _ := l.allow("1.2.3.4"); !ok {
			t.Fatal("Anfrage innerhalb des Limits abgelehnt")
		}
	}
	ok, retry := l.allow("1.2.3.4")
	if ok || retry < 1 {
		t.Fatal("Limit nicht durchgesetzt", retry)
	}
	if ok, _ := l.allow("5.6.7.8"); !ok {
		t.Fatal("andere IP fälschlich begrenzt")
	}
}
