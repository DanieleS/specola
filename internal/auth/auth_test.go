package auth

import "testing"

func TestSafeNext(t *testing.T) {
	for in, want := range map[string]string{
		"":                     "/",
		"/":                    "/",
		"/app/abc/":            "/app/abc/",
		"/view/x?v=2":          "/view/x?v=2",
		"/#/p/abc":             "/#/p/abc",
		"//evil.example":       "/",
		"/\\evil.example":      "/",
		"https://evil.example": "/",
		"evil.example":         "/",
		"javascript:alert(1)":  "/",
		"/a\r\nSet-Cookie: x":  "/",
	} {
		if got := SafeNext(in); got != want {
			t.Errorf("SafeNext(%q) = %q, want %q", in, got, want)
		}
	}
}
