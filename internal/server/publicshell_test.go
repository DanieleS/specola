package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"
)

// publicBundle is an app with a backend that makes some routes and a topic
// public.
var publicBundle = files{
	"index.html":    `<script type="module" src="__SPECOLA_BASE__/assets/app.js"></script>`,
	"assets/app.js": `specola.fetch("/api/stats")`,
	".specola/backend.json": `{"version":1,"public":["GET /api/stats","POST /api/votes","GET /api/public/*","get /"],
		"topics":{"public":["scoreboard"]}}`,
	".specola/server/index.mjs": `export default { fetch: () => new Response("hi") }`,
}

// publicLink makes a public link (following the current version) on page as
// alice and returns its token.
func publicLink(t *testing.T, ts *httptest.Server, page, label string) string {
	t.Helper()
	code, body := call(t, ts, "alice", "POST", "/api/pages/"+page+"/links", `{"label":"`+label+`"}`)
	if code != http.StatusCreated {
		t.Fatalf("link: %d %s", code, body)
	}
	var l struct{ URL string }
	mustJSON(t, body, &l)
	_, token, _ := strings.Cut(l.URL, "/s/")
	return token
}

// publicCall calls a backend through a public link, showing version v (none
// when 0), from the address the X-Forwarded-For header names when xff is
// set.
func publicCall(t *testing.T, ts *httptest.Server, method, path string, v int, body io.Reader, h http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	for k, vs := range h {
		req.Header[k] = vs
	}
	if v > 0 {
		req.Header.Set("X-Specola-Version", fmt.Sprint(v))
	}
	res, err := noGzip.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

func (fr *fakeRunner) count() int {
	fr.mu.Lock()
	defer fr.mu.Unlock()
	return len(fr.calls)
}

// servedBoot is the boot data the real shell (publicshell.html) was served
// with: the argument of the call that ends its inline script, "})(<boot>);".
func servedBoot(t *testing.T, body string) string {
	t.Helper()
	i, j := strings.LastIndex(body, "})("), strings.LastIndex(body, ");\n</script>")
	if i < 0 || j < i {
		t.Fatalf("no boot data in the shell: %.200s", body)
	}
	return body[i+len("})(") : j]
}

func TestPublicShell(t *testing.T) {
	fr := newFakeRunner(t)
	ts, _, _ := newBackendTestServer(t, fr)
	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Votes"}`), publicBundle, "")
	token := publicLink(t, ts, page, "fans")

	t.Run("shell", func(t *testing.T) {
		res := get(t, ts, "", "/s/"+token+"/scores/top?a=1&b=%3C/script%3E<", nil)
		body := readBody(t, res)
		want := map[string]string{
			"Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src 'self'; connect-src 'self'; style-src 'unsafe-inline'",
			"Cache-Control":           "no-store",
			"Referrer-Policy":         "no-referrer",
			"X-Robots-Tag":            "noindex",
			"Content-Type":            "text/html; charset=utf-8",
		}
		for k, v := range want {
			if res.Header.Get(k) != v {
				t.Errorf("%s = %q, want %q", k, res.Header.Get(k), v)
			}
		}
		if res.StatusCode != http.StatusOK || strings.Contains(body, "SPECOLA_SHELL_BOOT") {
			t.Fatalf("shell: %d %.300s", res.StatusCode, body)
		}
		raw := servedBoot(t, body)
		// The path's < and the encoded </script> stay escaped in the script.
		if strings.ContainsAny(raw, "<>&") {
			t.Fatalf("boot not escaped: %s", raw)
		}
		var boot struct {
			Token   string
			Version int
			Backend backendState
			PageSrc string
		}
		mustJSON(t, raw, &boot)
		if boot.Token != token || boot.Version != 1 || boot.Backend != (backendState{true, true}) ||
			boot.PageSrc != "/s/"+token+"/~page/scores/top?a=1&b=%3C/script%3E<" {
			t.Fatalf("boot = %+v", boot)
		}
		res = get(t, ts, "", "/s/"+token, nil)
		mustJSON(t, servedBoot(t, readBody(t, res)), &boot)
		if boot.PageSrc != "/s/"+token+"/~page" {
			t.Fatalf("root: %+v", boot)
		}
	})

	t.Run("page in the frame", func(t *testing.T) {
		for _, path := range []string{"/s/" + token + "/~page", "/s/" + token + "/~page/scores/top"} {
			res := get(t, ts, "", path, nil)
			body := readBody(t, res)
			if res.StatusCode != http.StatusOK || !strings.Contains(body, `"basename":"/s/`+token+`/~page","backend":true}`) ||
				!strings.HasSuffix(res.Header.Get("Content-Security-Policy"), "frame-ancestors 'self'") ||
				!strings.HasPrefix(res.Header.Get("Content-Security-Policy"), "sandbox allow-scripts") ||
				res.Header.Get("Cache-Control") != "no-store" || !strings.Contains(body, "assets/app.js") {
				t.Fatalf("GET %s: %d %v %s", path, res.StatusCode, res.Header, body)
			}
		}
	})

	t.Run("bad links", func(t *testing.T) {
		for _, path := range []string{"/s/nope", "/s/nope/~page", "/s/nope/a"} {
			if res := get(t, ts, "", path, nil); res.StatusCode != http.StatusNotFound {
				t.Fatalf("GET %s: %d", path, res.StatusCode)
			}
		}
	})

	t.Run("page without a backend", func(t *testing.T) {
		code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"Plain","html":"<p>plain</p>"}`)
		plain := createdID(t, code, body)
		tok := publicLink(t, ts, plain, "")
		res := get(t, ts, "", "/s/"+tok+"/deep", nil)
		if b := readBody(t, res); res.StatusCode != http.StatusOK || b != served("<p>plain</p>", "/s/"+tok) ||
			!strings.HasSuffix(res.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatalf("plain page: %d %s", res.StatusCode, b)
		}
		if res := get(t, ts, "", "/s/"+tok+"/~page", nil); res.StatusCode != http.StatusNotFound {
			t.Fatalf("~page of a plain page: %d", res.StatusCode)
		}
		wantBackendError(t, publicCall(t, ts, "GET", "/p/"+tok+"/x/api/stats", 1, nil, nil), http.StatusNotFound, "no-backend")
	})
}

func TestPublicCalls(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, _ := newBackendTestServer(t, fr)
	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Votes"}`), publicBundle, "")
	token := publicLink(t, ts, page, "fans")
	x := "/p/" + token + "/x"

	t.Run("relayed as the public", func(t *testing.T) {
		listed, _ := json.Marshal([][2]string{{"Content-Type", "application/json"}, {"Cookie", "a=b"}, {"X-Mine", "1"}})
		h := http.Header{
			"X-Specola-Headers": {base64.RawURLEncoding.EncodeToString(listed)},
			"Authorization":     {"Basic eA=="},
			userHeader:          {"alice"},
		}
		res := publicCall(t, ts, "POST", x+"/api/votes?n=1", 1, strings.NewReader(`{"v":1}`), h)
		if b := readBody(t, res); res.StatusCode != http.StatusCreated || b != `{"ok":true}` || res.Header.Get("Set-Cookie") != "" {
			t.Fatalf("call: %d %v %s", res.StatusCode, res.Header, b)
		}
		c := fr.last(t)
		if c.head.User != nil || c.head.Role != "public" || c.head.Link == nil || c.head.Link.Label != "fans" || c.head.Link.ID == "" ||
			c.head.Page != (backend.Page{ID: page, Version: 1, Title: "Votes"}) || c.head.Request.Path != "/api/votes?n=1" ||
			c.body != `{"v":1}` || fmt.Sprint(c.head.Request.Headers) != "[[content-type application/json] [x-mine 1]]" ||
			c.head.Secrets == nil || c.head.Egress == nil {
			t.Fatalf("runner got %+v %q", c.head, c.body)
		}
		// GET /: the method of a route is case-insensitive in the manifest.
		for _, p := range []string{x, x + "/", x + "/api/public/", x + "/api/public/a/b", x + "/api/public/%61"} {
			if res := publicCall(t, ts, "GET", p, 1, nil, nil); res.StatusCode != http.StatusCreated {
				t.Fatalf("GET %s: %d %s", p, res.StatusCode, readBody(t, res))
			}
		}
	})

	t.Run("only public routes", func(t *testing.T) {
		before := fr.count()
		for _, c := range []struct{ method, path string }{
			{"POST", "/api/stats"}, {"HEAD", "/api/stats"}, {"GET", "/api/stats/"}, {"GET", "/api/statsx"},
			{"GET", "/api/admin"}, {"GET", "/api/public"}, {"GET", "/api//public/a"},
			{"GET", "/api/public/../admin"}, {"GET", "/api/public/%2e%2e/admin"}, {"GET", "/api/public/a%2F..%2F..%2Fadmin"},
			{"GET", "/api/public/a%5C..%5Cadmin"}, {"DELETE", "/api/votes"},
		} {
			res := publicCall(t, ts, c.method, x+c.path, 1, nil, nil)
			if c.method == "HEAD" {
				if res.StatusCode != http.StatusForbidden || res.Header.Get("X-Specola-Error") != "not-public" {
					t.Errorf("HEAD %s: %d", c.path, res.StatusCode)
				}
				continue
			}
			wantBackendError(t, res, http.StatusForbidden, "not-public")
		}
		if fr.count() != before {
			t.Fatal("the runner was called for a route that isn't public")
		}
	})

	t.Run("errors", func(t *testing.T) {
		wantBackendError(t, publicCall(t, ts, "GET", x+"/api/stats", 0, nil, nil), http.StatusBadRequest, "bad-request")
		wantBackendError(t, publicCall(t, ts, "GET", x+"/api/stats", 2, nil, nil), http.StatusConflict, "superseded")
		wantBackendError(t, publicCall(t, ts, "GET", "/p/nope/x/api/stats", 1, nil, nil), http.StatusNotFound, "not-found")
		if res := publicCall(t, ts, "GET", "/p/"+token+"/other", 1, nil, nil); res.StatusCode != http.StatusNotFound {
			t.Fatalf("/p/{token}/other: %d", res.StatusCode)
		}
		// A link that no longer works stops calls at once.
		tok := publicLink(t, ts, page, "soon gone")
		if res := publicCall(t, ts, "GET", "/p/"+tok+"/x/api/stats", 1, nil, nil); res.StatusCode != http.StatusCreated {
			t.Fatalf("before revoking: %d", res.StatusCode)
		}
		var links []struct{ ID, Label string }
		_, body := call(t, ts, "alice", "GET", "/api/pages/"+page+"/links", "")
		mustJSON(t, body, &links)
		for _, l := range links {
			if l.Label == "soon gone" {
				call(t, ts, "alice", "DELETE", "/api/pages/"+page+"/links/"+l.ID, "")
			}
		}
		wantBackendError(t, publicCall(t, ts, "GET", "/p/"+tok+"/x/api/stats", 1, nil, nil), http.StatusNotFound, "not-found")
		// Archived: the link is down.
		tok = publicLink(t, ts, page, "")
		call(t, ts, "alice", "POST", "/api/pages/"+page+"/archive", "")
		wantBackendError(t, publicCall(t, ts, "GET", "/p/"+tok+"/x/api/stats", 1, nil, nil), http.StatusNotFound, "not-found")
		call(t, ts, "alice", "POST", "/api/pages/"+page+"/unarchive", "")
		// The runner is down.
		s.runner.MarkUnavailable()
		wantBackendError(t, publicCall(t, ts, "GET", x+"/api/stats", 1, nil, nil), http.StatusServiceUnavailable, "backend-unavailable")
		s.runner.Check(context.Background())
	})

	t.Run("rate limits", func(t *testing.T) {
		// A fresh link, and a clock that stands still.
		tok := publicLink(t, ts, page, "limited")
		now := time.Now()
		s.now = func() time.Time { return now }
		t.Cleanup(func() { s.now = time.Now })
		p := "/p/" + tok + "/x/api/stats"
		spoofed := http.Header{"X-Forwarded-For": {"203.0.113.9"}}
		for i := range publicCallsPerIP {
			// X-Forwarded-For isn't trusted: every call is from the same
			// address, whatever it says.
			h := http.Header{"X-Forwarded-For": {fmt.Sprint("203.0.113.", i)}}
			if res := publicCall(t, ts, "GET", p, 1, nil, h); res.StatusCode != http.StatusCreated {
				t.Fatalf("call %d: %d", i, res.StatusCode)
			}
		}
		res := publicCall(t, ts, "GET", p, 1, nil, spoofed)
		wantBackendError(t, res, http.StatusTooManyRequests, "too-many-requests")
		if res.Header.Get("Retry-After") != "1" {
			t.Fatalf("Retry-After = %q", res.Header.Get("Retry-After"))
		}
		// Another link has its own budget.
		if res := publicCall(t, ts, "GET", x+"/api/stats", 1, nil, nil); res.StatusCode != http.StatusCreated {
			t.Fatalf("other link: %d", res.StatusCode)
		}
		// Trusted, the first hop is the address.
		s.cfg.TrustForwarded = true
		t.Cleanup(func() { s.cfg.TrustForwarded = false })
		if res := publicCall(t, ts, "GET", p, 1, nil, spoofed); res.StatusCode != http.StatusCreated {
			t.Fatalf("another address: %d", res.StatusCode)
		}
		// A second later, one more call.
		s.cfg.TrustForwarded = false
		now = now.Add(time.Second)
		if res := publicCall(t, ts, "GET", p, 1, nil, nil); res.StatusCode != http.StatusCreated {
			t.Fatalf("after a second: %d", res.StatusCode)
		}
		wantBackendError(t, publicCall(t, ts, "GET", p, 1, nil, nil), http.StatusTooManyRequests, "too-many-requests")
	})
}

func TestRateLimiter(t *testing.T) {
	var l rateLimiter
	now := time.Now()
	// 600 a minute per link, from 10 addresses at 60 each.
	for ip := range 10 {
		for i := range publicCallsPerIP {
			if wait := l.allow("L", fmt.Sprint(ip), now); wait != 0 {
				t.Fatalf("ip %d call %d: wait %v", ip, i, wait)
			}
		}
	}
	// The link's budget is spent: an eleventh address waits too, 100 ms
	// (600 a minute), and so its own budget is untouched.
	if wait := l.allow("L", "new", now); wait != 100*time.Millisecond {
		t.Fatalf("link spent: wait %v", wait)
	}
	if b := l.buckets["ip\x00L\x00new"]; b.tokens != publicCallsPerIP {
		t.Fatalf("a refused call took from the address's budget: %v", b.tokens)
	}
	if wait := l.allow("other", "0", now); wait != 0 {
		t.Fatalf("another link: wait %v", wait)
	}
	// An address that spent its budget waits a second (60 a minute).
	now = now.Add(time.Second)
	if wait := l.allow("L", "new", now); wait != 0 {
		t.Fatalf("after a second: wait %v", wait)
	}
	if wait := l.allow("L", "0", now); wait != 0 {
		t.Fatalf("address 0 after a second: %v", wait)
	}
	if wait := l.allow("L", "0", now); wait <= 0 || wait > time.Second {
		t.Fatalf("address 0 again: %v", wait)
	}
	// Idle buckets are dropped.
	now = now.Add(2 * time.Minute)
	l.allow("x", "y", now)
	if len(l.buckets) != 2 {
		t.Fatalf("buckets = %d", len(l.buckets))
	}
}

func TestPublicRouteRefusal(t *testing.T) {
	routes := []string{"GET /api/stats", "POST /api/votes", "GET /api/public/*", "GET /", "PUT /*", "GET /a/"}
	for _, c := range []struct {
		method, path string
		ok           bool
	}{
		{"GET", "/api/stats", true}, {"GET", "", true}, {"GET", "/", true},
		{"POST", "/api/votes", true}, {"GET", "/api/votes", false},
		{"GET", "/api/public/x", true}, {"GET", "/api/public/", true}, {"GET", "/api/public/x/y/z", true},
		{"GET", "/api/public", false}, {"GET", "/api/publicx/y", false},
		{"PUT", "/anything/at/all", true}, {"PUT", "/", true},
		{"GET", "/a/", true}, {"GET", "/a", false},
		{"GET", "/api/%73tats", true}, // decoded, as routers do
		{"GET", "/api/public/./x", false}, {"GET", "/api/public/%2E%2E", false}, {"PUT", "/a%2fb", false},
		{"PUT", "/a%5cb", false}, {"PUT", "/a\\b", false}, {"PUT", "/%", false},
	} {
		if got := publicRouteRefusal(routes, c.method, c.path) == ""; got != c.ok {
			t.Errorf("%s %s: allowed %v, want %v", c.method, c.path, got, c.ok)
		}
	}
	if publicRouteRefusal(nil, "GET", "/") == "" {
		t.Error("no public routes: allowed")
	}
}

func TestPublicEvents(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, _ := newBackendTestServer(t, fr)
	fastPush(s)
	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Votes"}`), publicBundle, "")
	token := publicLink(t, ts, page, "")
	ev := func(v int, topics ...string) string {
		return "/p/" + token + "/events?" + url.Values{"v": {fmt.Sprint(v)}, "topic": topics}.Encode()
	}

	wantBackendError(t, openEvents(t, ts, "", ev(1, "scoreboard", "orders"), nil).res, http.StatusForbidden, "not-public")
	wantBackendError(t, openEvents(t, ts, "", ev(1), nil).res, http.StatusBadRequest, "bad-request")
	wantBackendError(t, openEvents(t, ts, "", "/p/nope/events?v=1&topic=scoreboard", nil).res, http.StatusNotFound, "not-found")
	openEvents(t, ts, "", ev(2, "scoreboard"), nil).wantEnd(t, "superseded")

	st := openEvents(t, ts, "", ev(1, "scoreboard"), http.Header{"Accept-Encoding": {"gzip"}})
	if st.res.StatusCode != http.StatusOK || st.res.Header.Get("Content-Encoding") != "" {
		t.Fatalf("stream: %d %v", st.res.StatusCode, st.res.Header)
	}
	// Never a targeted event, not even one for nobody in particular.
	mustPublish(t, ts, `{"page":"`+page+`","topic":"scoreboard","data":"secret","to":""}`)
	mustPublish(t, ts, `{"page":"`+page+`","topic":"scoreboard","data":"for alice","to":"alice"}`)
	mustPublish(t, ts, `{"page":"`+page+`","topic":"scoreboard","data":"all"}`)
	st.want(t, "message", `{"topic":"scoreboard","data":"secret"}`)
	st.want(t, "message", `{"topic":"scoreboard","data":"all"}`)

	// Revoking the link ends its streams.
	var links []struct{ ID string }
	_, body := call(t, ts, "alice", "GET", "/api/pages/"+page+"/links", "")
	mustJSON(t, body, &links)
	call(t, ts, "alice", "DELETE", "/api/pages/"+page+"/links/"+links[0].ID, "")
	st.wantEnd(t, "forbidden")
}

func TestPublicLinksOnViewOriginWithBackend(t *testing.T) {
	fr := newFakeRunner(t)
	pool := testdb.New(t)
	cfg := backendConfig(fr.URL)
	cfg.ViewOrigin, cfg.SessionSecret = "http://view.test", "secret"
	s := New(cfg, store.New(pool), nil, nil)
	s.runner.Check(context.Background())
	ts := httptest.NewServer(s)
	defer ts.Close()

	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Votes"}`), publicBundle, "")
	token := publicLink(t, ts, page, "")
	for _, path := range []string{"/s/" + token, "/s/" + token + "/~page"} {
		if res := get(t, ts, "view.test", path, nil); res.StatusCode != http.StatusOK {
			t.Fatalf("view origin %s: %d", path, res.StatusCode)
		}
	}
	req, _ := http.NewRequest("GET", ts.URL+"/p/"+token+"/x/api/stats", nil)
	req.Host = "view.test"
	req.Header.Set("X-Specola-Version", "1")
	if res := mustDo(t, req); res.StatusCode != http.StatusCreated {
		t.Fatalf("call on the view origin: %d", res.StatusCode)
	}
	// Not on the app origin.
	for _, path := range []string{"/p/" + token + "/x/api/stats", "/s/" + token} {
		if res := publicCall(t, ts, "GET", path, 1, nil, nil); res.StatusCode != http.StatusNotFound {
			t.Fatalf("app origin %s: %d", path, res.StatusCode)
		}
	}
}

func TestCallBackendAs(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, _ := newBackendTestServer(t, fr)
	page := publishBackendPage(t, ts)
	ctx := context.Background()

	res, err := s.CallBackendAs(ctx, "alice", page, "post", "/api/orders?x=1", [][2]string{{"Content-Type", "application/json"}, {"Cookie", "a=b"}, {"X-Specola-Version", "9"}}, []byte(`{"n":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if b := readBody(t, res); res.StatusCode != http.StatusCreated || b != `{"ok":true}` || res.Header.Get("Set-Cookie") != "" ||
		res.Header.Get("X-Kept") != "yes" || res.Header.Get("Content-Security-Policy") == "" {
		t.Fatalf("call: %d %v %s", res.StatusCode, res.Header, b)
	}
	res.Body.Close()
	c := fr.last(t)
	if c.head.Request.Method != "POST" || c.head.Request.Path != "/api/orders?x=1" || c.body != `{"n":1}` ||
		c.head.User == nil || c.head.User.Sub != "alice" || c.head.Role != "owner" ||
		fmt.Sprint(c.head.Request.Headers) != "[[content-type application/json]]" {
		t.Fatalf("runner got %+v %q", c.head, c.body)
	}

	// Streams as it comes.
	res, err = s.CallBackendAs(ctx, "alice", page, "GET", "/stream", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 64)
	n, _ := res.Body.Read(buf)
	if string(buf[:n]) != `{"part":1}`+"\n" {
		t.Fatalf("first chunk %q", buf[:n])
	}
	fr.next <- struct{}{}
	if rest, _ := io.ReadAll(res.Body); string(rest) != `{"part":2}`+"\n" {
		t.Fatalf("rest %q", rest)
	}
	res.Body.Close()

	// Specola's own errors are responses.
	res, err = s.CallBackendAs(ctx, "alice", page, "GET", "/error", nil, nil)
	if err != nil || res.StatusCode != http.StatusInternalServerError || res.Header.Get("X-Specola-Error") != "backend-error" {
		t.Fatalf("error: %v %v", err, res)
	}
	res.Body.Close()
	s.runner.MarkUnavailable()
	res, err = s.CallBackendAs(ctx, "alice", page, "GET", "/", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	wantBackendError(t, res, http.StatusServiceUnavailable, "backend-unavailable")
	s.runner.Check(ctx)

	// A runner that stops mid-answer: the body ends in an error.
	res, err = s.CallBackendAs(ctx, "alice", page, "GET", "/abort", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(res.Body); err == nil {
		t.Fatal("a cut answer read as complete")
	}

	// The caller giving up ends the call on the runner.
	slowCtx, cancel := context.WithCancel(ctx)
	go func() { <-fr.arrived; cancel() }()
	if _, err := s.CallBackendAs(slowCtx, "alice", page, "GET", "/slow", nil, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
	select {
	case <-fr.gone:
	case <-time.After(5 * time.Second):
		t.Fatal("the runner's call went on")
	}

	// Access is the user's.
	if _, err := s.CallBackendAs(ctx, "carol", page, "GET", "/", nil, nil); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("carol: %v", err)
	}
	if _, err := s.CallBackendAs(ctx, "alice", page, "GET", "no-slash", nil, nil); err == nil {
		t.Fatal("a relative path was accepted")
	}
}

func TestInvokeHeadSecrets(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, pool := newBackendTestServer(t, fr)
	f := files{}
	for k, v := range publicBundle {
		f[k] = v
	}
	f[".specola/backend.json"] = `{"version":1,"public":["GET /api/stats"],"secrets":["API_KEY","UNSET"],"egress":["api.example.com","*.example.org"]}`
	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Keys"}`), f, "")
	st := store.New(pool)
	for name, value := range map[string]string{"API_KEY": "s3cret", "UNDECLARED": "nope"} {
		if err := st.SetPageSecret(context.Background(), "alice", page, name, value, s.cfg.SecretsKey); err != nil {
			t.Fatal(err)
		}
	}
	want := func(how string) {
		t.Helper()
		c := fr.last(t)
		if fmt.Sprint(c.head.Secrets) != "map[API_KEY:s3cret]" || fmt.Sprint(c.head.Egress) != "[api.example.com *.example.org]" {
			t.Fatalf("%s: secrets %v egress %v", how, c.head.Secrets, c.head.Egress)
		}
	}
	readBody(t, callBackend(t, ts, context.Background(), "alice", "GET", "/api/pages/"+page+"/x/a", 1, nil, nil))
	want("viewer call")
	readBody(t, publicCall(t, ts, "GET", "/p/"+publicLink(t, ts, page, "")+"/x/api/stats", 1, nil, nil))
	want("public call")
	res, err := s.CallBackendAs(context.Background(), "alice", page, "GET", "/a", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	readBody(t, res)
	want("CallBackendAs")

	secrets, egress, err := s.backendSecretsAndEgress(context.Background(), page, backend.Manifest{})
	if err != nil || secrets == nil || len(secrets) != 0 || egress == nil || len(egress) != 0 {
		t.Fatalf("nothing declared: %v %v %v", secrets, egress, err)
	}
}

// The shell names its boot placeholder exactly once, and only the first is
// replaced: a second would be served as is, or, if replaced, be a place page
// data could reach outside a string.
func TestPublicShellPlaceholder(t *testing.T) {
	if n := strings.Count(publicShellHTML, shellBootPlaceholder); n != 1 {
		t.Fatalf("publicshell.html names %s %d times, want once", shellBootPlaceholder, n)
	}
}
