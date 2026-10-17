package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"
)

const viewOrigin = "https://view.specola.test"

func TestViewOnAppOrigin(t *testing.T) {
	ts := newTestServer(t)
	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"P","html":"<p>hi</p>"}`)
	id := createdID(t, code, body)

	_, body = call(t, ts, "alice", "GET", "/api/pages/"+id, "")
	var meta struct{ ViewURL string }
	mustJSON(t, body, &meta)
	if meta.ViewURL != "/view/"+id {
		t.Fatalf("viewUrl = %q", meta.ViewURL)
	}

	res := get(t, ts, "", "/view/"+id, http.Header{userHeader: {"alice"}})
	csp := res.Header.Get("Content-Security-Policy")
	if !strings.Contains(csp, "sandbox allow-scripts") || !strings.Contains(csp, "frame-ancestors 'self'") {
		t.Fatalf("CSP = %q", csp)
	}
	if res.Header.Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q", res.Header.Get("Referrer-Policy"))
	}
	if acao := res.Header.Get("Access-Control-Allow-Origin"); acao != "" {
		t.Fatalf("same-origin view allows CORS from %q", acao)
	}
}

func TestSeparateViewOrigin(t *testing.T) {
	cfg := &config.Config{
		AppBaseURL:        "https://specola.test",
		TrustedUserHeader: userHeader,
		ViewOrigin:        viewOrigin,
		SessionSecret:     "test-secret-test-secret-test-secret",
	}
	srv := New(cfg, store.New(testdb.New(t)), nil, nil)
	ts := httptest.NewServer(srv)
	t.Cleanup(ts.Close)
	const viewHost = "view.specola.test"
	const alice, bob = "alice@example.com", "bob@example.com"
	call(t, ts, bob, "GET", "/api/me", "")

	code, body := call(t, ts, alice, "POST", "/api/pages", `{"name":"P","html":"<p>v1</p>"}`)
	id := createdID(t, code, body)
	call(t, ts, alice, "POST", "/api/pages/"+id+"/versions", `{"html":"<p>v2</p>"}`)

	viewURL := func(user string) *url.URL {
		t.Helper()
		_, body := call(t, ts, user, "GET", "/api/pages/"+id, "")
		var meta struct{ ViewURL string }
		mustJSON(t, body, &meta)
		u, err := url.Parse(meta.ViewURL)
		if err != nil || u.Scheme+"://"+u.Host != viewOrigin || u.Path != "/view/"+id || u.Query().Get("t") == "" {
			t.Fatalf("viewUrl = %q", meta.ViewURL)
		}
		return u
	}
	u := viewURL(alice)

	// The app origin no longer serves page HTML, even when signed in.
	if code, body := call(t, ts, alice, "GET", "/view/"+id, ""); code != http.StatusNotFound || strings.Contains(body, "<p>v") {
		t.Fatalf("app origin /view: %d %q, want 404", code, body)
	}

	// The view origin serves it with the token, no session needed.
	res := get(t, ts, viewHost, u.RequestURI(), nil)
	if b := readBody(t, res); res.StatusCode != http.StatusOK || b != withSDK("<p>v2</p>") {
		t.Fatalf("view origin: %d %q", res.StatusCode, b)
	}
	// The app may read it too, to keep it for offline viewing.
	if acao := res.Header.Get("Access-Control-Allow-Origin"); acao != cfg.AppBaseURL {
		t.Fatalf("Access-Control-Allow-Origin = %q, want the app origin", acao)
	}
	if csp := res.Header.Get("Content-Security-Policy"); !strings.Contains(csp, "frame-ancestors https://specola.test") {
		t.Fatalf("CSP = %q", csp)
	}
	q := u.Query()
	q.Set("v", "1")
	if b := readBody(t, get(t, ts, viewHost, u.Path+"?"+q.Encode(), nil)); b != withSDK("<p>v1</p>") {
		t.Fatalf("v=1: %q", b)
	}

	// The view origin serves nothing else.
	for _, path := range []string{"/", "/api/me", "/api/tree"} {
		if res := get(t, ts, viewHost, path, http.Header{userHeader: {alice}}); res.StatusCode != http.StatusNotFound {
			t.Fatalf("view origin %s: %d, want 404", path, res.StatusCode)
		}
	}

	// Bad tokens are refused.
	tok := u.Query().Get("t")
	code, body = call(t, ts, alice, "POST", "/api/pages", `{"name":"Q","html":"x"}`)
	other := createdID(t, code, body)
	vt := srv.tokens
	for name, path := range map[string]string{
		"none":          "/view/" + id,
		"tampered":      "/view/" + id + "?t=" + tok[:len(tok)-2] + "xx",
		"other page":    "/view/" + other + "?t=" + tok,
		"expired":       "/view/" + id + "?t=" + vt.mint(alice, id, time.Now().Add(-2*viewTokenTTL)),
		"other secret":  "/view/" + id + "?t=" + newViewTokens("another-secret").mint(alice, id, time.Now()),
		"garbage":       "/view/" + id + "?t=not.a-token",
		"no signature":  "/view/" + id + "?t=" + strings.Split(tok, ".")[0],
		"empty payload": "/view/" + id + "?t=." + strings.Split(tok, ".")[1],
	} {
		if res := get(t, ts, viewHost, path, nil); res.StatusCode != http.StatusForbidden {
			t.Errorf("%s: %d, want 403", name, res.StatusCode)
		}
	}

	// A valid token doesn't outlive access: access is checked on every view.
	call(t, ts, alice, "PUT", "/api/pages/"+id+"/acl", `{"email":"`+bob+`","role":"viewer"}`)
	bu := viewURL(bob)
	if res := get(t, ts, viewHost, bu.RequestURI(), nil); res.StatusCode != http.StatusOK {
		t.Fatalf("bob with share: %d", res.StatusCode)
	}
	call(t, ts, alice, "DELETE", "/api/pages/"+id+"/acl?sub="+bob, "")
	if res := get(t, ts, viewHost, bu.RequestURI(), nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("bob after unshare: %d, want 404", res.StatusCode)
	}
}

// get sends a GET with the given Host header (the test server's own when
// empty) and returns the response.
func get(t *testing.T, ts *httptest.Server, host, path string, h http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequest("GET", ts.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if host != "" {
		req.Host = host
	}
	for k, v := range h {
		req.Header[k] = v
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func readBody(t *testing.T, res *http.Response) string {
	t.Helper()
	b, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
