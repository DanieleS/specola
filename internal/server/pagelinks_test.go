package server

import (
	"net/http/httptest"
	"strings"
	"testing"
)

// Both private views and public links use writePage, including on a separate
// view origin. Assert both CSP modes without needing a database.
func TestPageLinkSandbox(t *testing.T) {
	for _, ancestors := range []string{"'self'", "https://specola.test", "'none'"} {
		t.Run(ancestors, func(t *testing.T) {
			w := httptest.NewRecorder()
			writePage(w, "<!doctype html><a href=\"https://example.test/\">link</a>", ancestors)
			csp := w.Header().Get("Content-Security-Policy")
			want := "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals; frame-ancestors " + ancestors
			if csp != want {
				t.Fatalf("CSP = %q, want %q", csp, want)
			}
			if strings.Contains(csp, "allow-same-origin") || strings.Contains(csp, "allow-top-navigation") {
				t.Fatal("page isolation was weakened")
			}
			body := w.Body.String()
			if !strings.HasPrefix(body, "<!doctype html><script>") || !strings.Contains(body, "function externalLink(e)") {
				t.Fatalf("page runtime not injected after doctype: %s", body)
			}
			if w.Header().Get("Referrer-Policy") != "no-referrer" {
				t.Fatal("referrer policy lost")
			}
		})
	}
}
