package server

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"

	"github.com/jackc/pgx/v5/pgxpool"
)

const runnerToken = "runner-token"

// fakeRunner stands in for the backend runner: it records the calls it gets
// and answers each by its path.
type fakeRunner struct {
	*httptest.Server
	mu      sync.Mutex
	calls   []runnerCall
	next    chan struct{} // lets /stream send its second chunk
	arrived chan struct{} // a /slow call arrived
	release chan struct{} // closed: /slow calls answer
	gone    chan struct{} // a /slow call saw its caller go away
	data    fakeData      // the data routes (backenddata_test.go)
}

type runnerCall struct {
	head backend.Invoke
	body string
}

func newFakeRunner(t *testing.T) *fakeRunner {
	t.Helper()
	fr := &fakeRunner{next: make(chan struct{}), arrived: make(chan struct{}, 100), release: make(chan struct{}), gone: make(chan struct{}, 100)}
	fr.data.init()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"ok":true,"version":"test"}`)
	})
	mux.HandleFunc("GET /logs", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"lines":[{"seq":7,"time":"2026-01-01T00:00:00Z","level":"log","text":"page=%s since=%s"}]}`,
			r.URL.Query().Get("page"), r.URL.Query().Get("since"))
	})
	mux.HandleFunc("/pages/", fr.serveData)
	mux.HandleFunc("POST /invoke", func(w http.ResponseWriter, r *http.Request) {
		var c runnerCall
		raw, err := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Specola-Invoke"))
		if err != nil || json.Unmarshal(raw, &c.head) != nil {
			http.Error(w, "bad head", http.StatusBadRequest)
			return
		}
		path, _, _ := strings.Cut(c.head.Request.Path, "?")
		if path == "/early" {
			// The head first, then the body: as a handler that streams while
			// it reads its request.
			_ = http.NewResponseController(w).EnableFullDuplex()
			w.WriteHeader(http.StatusAccepted)
			io.WriteString(w, "reading ")
			w.(http.Flusher).Flush()
			n, err := io.Copy(io.Discard, r.Body)
			fmt.Fprintf(w, "%d %v", n, err)
			return
		}
		if path == "/big" {
			_, _ = io.Copy(io.Discard, r.Body)
		} else {
			b, _ := io.ReadAll(r.Body)
			c.body = string(b)
		}
		fr.mu.Lock()
		fr.calls = append(fr.calls, c)
		fr.mu.Unlock()
		switch path {
		case "/stream":
			w.Header().Set("Content-Type", "application/json")
			io.WriteString(w, `{"part":1}`+"\n")
			w.(http.Flusher).Flush()
			select {
			case <-fr.next:
			case <-r.Context().Done():
				return
			}
			io.WriteString(w, `{"part":2}`+"\n")
		case "/slow":
			fr.arrived <- struct{}{}
			select {
			case <-fr.release:
				io.WriteString(w, "done")
			case <-r.Context().Done():
				fr.gone <- struct{}{}
			}
		case "/hangup":
			// The runner goes away before any answer.
			conn, _, _ := http.NewResponseController(w).Hijack()
			conn.Close()
		case "/abort":
			// Half an answer, then the runner goes away.
			w.Header().Set("Content-Length", "100")
			io.WriteString(w, "partial")
			w.(http.Flusher).Flush()
			conn, _, _ := http.NewResponseController(w).Hijack()
			conn.Close()
		case "/error":
			w.Header().Set("X-Specola-Error", "backend-error")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, `{"error":"backend-error","ref":"r1"}`)
		default:
			w.Header().Set("Content-Type", "application/json")
			w.Header().Add("Set-Cookie", "session=stolen")
			w.Header().Set("Connection", "X-Hop")
			w.Header().Set("X-Hop", "1")
			w.Header().Set("X-Kept", "yes")
			w.Header().Set("Clear-Site-Data", `"cookies", "storage"`)
			w.Header().Set("NEL", `{"report_to":"x","max_age":31536000}`)
			w.Header().Set("Report-To", `{"group":"x","max_age":31536000,"endpoints":[{"url":"https://evil.example/r"}]}`)
			w.Header().Set("Access-Control-Allow-Origin", "https://evil.example")
			w.WriteHeader(http.StatusCreated)
			io.WriteString(w, `{"ok":true}`)
		}
	})
	fr.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+runnerToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(fr.Close)
	return fr
}

func (fr *fakeRunner) last(t *testing.T) runnerCall {
	t.Helper()
	fr.mu.Lock()
	defer fr.mu.Unlock()
	if len(fr.calls) == 0 {
		t.Fatal("the runner got no call")
	}
	return fr.calls[len(fr.calls)-1]
}

// backendConfig is a configuration with backends on the runner at url.
func backendConfig(url string) *config.Config {
	return &config.Config{AppBaseURL: "http://test", TrustedUserHeader: userHeader,
		RunnerURL: url, RunnerToken: runnerToken, SecretsKey: make([]byte, 32)}
}

// newBackendTestServer runs Specola with backends on fr, its health checked
// once.
func newBackendTestServer(t *testing.T, fr *fakeRunner) (*httptest.Server, *Server, *pgxpool.Pool) {
	t.Helper()
	pool := testdb.New(t)
	s := New(backendConfig(fr.URL), store.New(pool), nil, nil)
	if !s.runner.Check(context.Background()) {
		t.Fatal("fake runner not healthy")
	}
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)
	return ts, s, pool
}

// backendBundle is an app with a backend.
var backendBundle = files{
	"index.html":                `<script type="module" src="__SPECOLA_BASE__/assets/app.js"></script>`,
	"assets/app.js":             `specola.fetch("/api")`,
	".specola/backend.json":     `{"version":1,"egress":["api.example.com"]}`,
	".specola/server/index.mjs": `export default { fetch: () => new Response("hi") }`,
}

// publishBackendPage publishes backendBundle as a new page of alice's.
func publishBackendPage(t *testing.T, ts *httptest.Server) string {
	t.Helper()
	id, v := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Shop"}`), backendBundle, "")
	if v != 1 {
		t.Fatalf("version %d", v)
	}
	return id
}

// noGzip is a client that shows the response's encoding as it is.
var noGzip = &http.Client{Transport: &http.Transport{DisableCompression: true}}

// callBackend sends a backend call as user, showing version v, and returns
// the response. h are the page's headers: sent, and listed in
// X-Specola-Headers, as the viewer does.
func callBackend(t *testing.T, ts *httptest.Server, ctx context.Context, user, method, path string, v int, body io.Reader, h http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequestWithContext(ctx, method, ts.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	var page [][2]string
	for k, vs := range h {
		req.Header[k] = vs
		for _, v := range vs {
			page = append(page, [2]string{k, v})
		}
	}
	if page != nil {
		b, _ := json.Marshal(page)
		req.Header.Set("X-Specola-Headers", base64.RawURLEncoding.EncodeToString(b))
	}
	req.Header.Set(userHeader, user)
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

// wantBackendError checks an error specola produced about a backend call.
func wantBackendError(t *testing.T, res *http.Response, status int, code string) {
	t.Helper()
	var body struct{ Error, Message string }
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != status || res.Header.Get("X-Specola-Error") != code || json.Unmarshal(b, &body) != nil ||
		body.Error != code || body.Message == "" {
		t.Fatalf("got %d %q %s, want %d %s", res.StatusCode, res.Header.Get("X-Specola-Error"), b, status, code)
	}
}

func TestBackendCalls(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, _ := newBackendTestServer(t, fr)
	ctx := context.Background()
	page := publishBackendPage(t, ts)
	x := "/api/pages/" + page + "/x"

	t.Run("relayed", func(t *testing.T) {
		h := http.Header{
			"Content-Type":    {"application/json"},
			"Cookie":          {"specola_session=secret"},
			"X-Specola-Other": {"1"},
			"Connection":      {"X-Drop"},
			"X-Drop":          {"1"},
			"Accept-Encoding": {"gzip"},
			"X-Custom":        {"a", "b"},
		}
		res := callBackend(t, ts, ctx, "alice", "POST", x+"/api/orders?x=1&y=%2F", 1, strings.NewReader(`{"n":1}`), h)
		body := readBody(t, res)
		if res.StatusCode != http.StatusCreated || body != `{"ok":true}` {
			t.Fatalf("call: %d %s", res.StatusCode, body)
		}
		for _, h := range []string{"Clear-Site-Data", "NEL", "Report-To", "Access-Control-Allow-Origin"} {
			if res.Header.Get(h) != "" {
				t.Errorf("response header %s reached the caller", h)
			}
		}
		if res.Header.Get("Set-Cookie") != "" || res.Header.Get("X-Hop") != "" || res.Header.Get("X-Kept") != "yes" ||
			res.Header.Get("Content-Encoding") != "" || res.Header.Get("X-Content-Type-Options") != "nosniff" ||
			!strings.HasPrefix(res.Header.Get("Content-Security-Policy"), "sandbox") {
			t.Fatalf("response headers: %v", res.Header)
		}
		c := fr.last(t)
		if c.body != `{"n":1}` || c.head.Request.Method != "POST" || c.head.Request.Path != "/api/orders?x=1&y=%2F" ||
			c.head.Page != (backend.Page{ID: page, Version: 1, Title: "Shop"}) || c.head.Role != "owner" ||
			c.head.User == nil || c.head.User.Sub != "alice" || c.head.Link != nil || len(c.head.Secrets) != 0 ||
			strings.Join(c.head.Egress, ",") != "api.example.com" || len(c.head.CodeHash) != 64 || c.head.VersionID == "" {
			t.Fatalf("runner got %+v, body %q", c.head, c.body)
		}
		got := map[string][]string{}
		for _, kv := range c.head.Request.Headers {
			got[kv[0]] = append(got[kv[0]], kv[1])
		}
		for _, gone := range []string{"cookie", "x-specola-other", "x-specola-version", "connection", "x-drop", "accept-encoding", "host", strings.ToLower(userHeader)} {
			if _, ok := got[gone]; ok {
				t.Errorf("header %s reached the backend: %v", gone, got)
			}
		}
		if strings.Join(got["x-custom"], ",") != "a,b" || got["content-type"][0] != "application/json" {
			t.Errorf("headers = %v", got)
		}

		// The root of the backend, and its code hash is the version's.
		res = callBackend(t, ts, ctx, "alice", "GET", x, 1, nil, nil)
		readBody(t, res)
		if c2 := fr.last(t); c2.head.Request.Path != "/" || c2.head.CodeHash != c.head.CodeHash || c2.body != "" {
			t.Fatalf("root call: %+v", c2.head.Request)
		}
	})

	t.Run("only the page's headers", func(t *testing.T) {
		// What the browser or a proxy in front adds on the way is not the
		// page's: only what the viewer listed reaches the handler.
		req, _ := http.NewRequest("GET", ts.URL+x+"/h", nil)
		req.Header.Set(userHeader, "alice")
		req.Header.Set("X-Specola-Version", "1")
		req.Header.Set("Authorization", "Basic YWxpY2U6c2VjcmV0")
		req.Header.Set("X-Forwarded-Access-Token", "idp-token")
		req.Header.Set("X-Mine", "1")
		req.Header.Set("X-Specola-Headers", base64.RawURLEncoding.EncodeToString([]byte(`[["X-Mine","1"],["Accept","text/plain"]]`)))
		readBody(t, mustDo(t, req))
		if got := fr.last(t).head.Request.Headers; fmt.Sprint(got) != "[[accept text/plain] [x-mine 1]]" {
			t.Fatalf("headers = %v", got)
		}
		// None listed: none forwarded.
		req.Header.Del("X-Specola-Headers")
		readBody(t, mustDo(t, req))
		if got := fr.last(t).head.Request.Headers; got == nil || len(got) != 0 {
			t.Fatalf("headers = %#v", got)
		}
		req.Header.Set("X-Specola-Headers", "not json")
		wantBackendError(t, mustDo(t, req), http.StatusBadRequest, "bad-request")
	})

	t.Run("one id per page", func(t *testing.T) {
		// Postgres reads a uuid in upper case or without hyphens too; the
		// runner must still see one page.
		for _, spelling := range []string{strings.ToUpper(page), strings.ReplaceAll(page, "-", "")} {
			readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+spelling+"/x/a", 1, nil, nil))
			if c := fr.last(t); c.head.Page.ID != page || c.head.Request.Path != "/a" {
				t.Fatalf("%s: runner got page %q path %q", spelling, c.head.Page.ID, c.head.Request.Path)
			}
		}
		code, body := call(t, ts, "alice", "GET", "/api/pages/"+strings.ToUpper(page)+"/backend/logs", "")
		if code != http.StatusOK || !strings.Contains(body, "page="+page+" ") {
			t.Fatalf("logs: %d %s", code, body)
		}
	})

	t.Run("full duplex", func(t *testing.T) {
		// The runner's head arrives while the page is still uploading: the
		// rest of the body must still reach it, and the answer the page.
		pr, pw := io.Pipe()
		const size = 200_000
		go func() {
			chunk := make([]byte, 16<<10)
			for sent := 0; sent < size; sent += len(chunk) {
				if size-sent < len(chunk) {
					chunk = chunk[:size-sent]
				}
				time.Sleep(15 * time.Millisecond)
				if _, err := pw.Write(chunk); err != nil {
					return
				}
			}
			pw.Close()
		}()
		req, _ := http.NewRequest("POST", ts.URL+x+"/early", pr)
		req.ContentLength = size
		req.Header.Set(userHeader, "alice")
		req.Header.Set("X-Specola-Version", "1")
		res := mustDo(t, req)
		b, err := io.ReadAll(res.Body)
		if err != nil || res.StatusCode != http.StatusAccepted || string(b) != fmt.Sprintf("reading %d <nil>", size) {
			t.Fatalf("early head: %d %q %v", res.StatusCode, b, err)
		}
	})

	t.Run("roles", func(t *testing.T) {
		for _, role := range []string{"viewer", "editor"} {
			user := role + "@example.com"
			if code, body := call(t, ts, "alice", "PUT", "/api/pages/"+page+"/acl", `{"sub":"`+user+`","role":"`+role+`"}`); code != http.StatusNoContent {
				t.Fatalf("share: %d %s", code, body)
			}
			readBody(t, callBackend(t, ts, ctx, user, "GET", x+"/me", 1, nil, nil))
			if c := fr.last(t); c.head.Role != role || c.head.User.Sub != user || c.head.User.Email != user {
				t.Fatalf("%s: %+v", role, c.head)
			}
		}
		wantBackendError(t, callBackend(t, ts, ctx, "mallory", "GET", x+"/me", 1, nil, nil), http.StatusNotFound, "not-found")
	})

	t.Run("checks", func(t *testing.T) {
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", x+"/a", 0, nil, nil), http.StatusBadRequest, "bad-request")
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", x+"/a", 2, nil, nil), http.StatusConflict, "superseded")
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/nope/x/a", 1, nil, nil), http.StatusNotFound, "not-found")
		// The runner's own errors pass through.
		res := callBackend(t, ts, ctx, "alice", "GET", x+"/error", 1, nil, nil)
		if b := readBody(t, res); res.StatusCode != 500 || res.Header.Get("X-Specola-Error") != "backend-error" || !strings.Contains(b, `"ref":"r1"`) {
			t.Fatalf("runner error: %d %s", res.StatusCode, b)
		}
		// Anonymous: the session is required.
		req, _ := http.NewRequest("GET", ts.URL+x+"/a", nil)
		req.Header.Set("X-Specola-Version", "1")
		if res, _ := http.DefaultClient.Do(req); res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("anonymous: %d", res.StatusCode)
		}
	})

	t.Run("streams", func(t *testing.T) {
		res := callBackend(t, ts, ctx, "alice", "GET", x+"/stream", 1, nil, http.Header{"Accept-Encoding": {"gzip"}})
		if res.Header.Get("Content-Encoding") != "" {
			t.Fatalf("streamed response compressed: %v", res.Header)
		}
		rd := bufio.NewReader(res.Body)
		first, err := rd.ReadString('\n')
		if err != nil || first != `{"part":1}`+"\n" {
			t.Fatalf("first chunk %q, %v", first, err)
		}
		// Only now may the runner send the rest: the first chunk came alone.
		fr.next <- struct{}{}
		rest, _ := io.ReadAll(rd)
		if string(rest) != `{"part":2}`+"\n" {
			t.Fatalf("rest %q", rest)
		}
	})

	t.Run("no answer", func(t *testing.T) {
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", x+"/hangup", 1, nil, nil), http.StatusBadGateway, "backend-crashed")
		if !s.runner.Available() {
			t.Fatal("a runner that answered nothing, but was reached, is still available")
		}
	})

	t.Run("cut short", func(t *testing.T) {
		res := callBackend(t, ts, ctx, "alice", "GET", x+"/abort", 1, nil, nil)
		if b, err := io.ReadAll(res.Body); err == nil {
			t.Fatalf("an answer cut short reads as complete: %q", b)
		}
	})

	t.Run("cancels", func(t *testing.T) {
		cctx, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			defer close(done)
			req, _ := http.NewRequestWithContext(cctx, "GET", ts.URL+x+"/slow", nil)
			req.Header.Set(userHeader, "alice")
			req.Header.Set("X-Specola-Version", "1")
			if res, err := http.DefaultClient.Do(req); err == nil {
				res.Body.Close()
			}
		}()
		<-fr.arrived
		cancel()
		select {
		case <-fr.gone:
		case <-time.After(5 * time.Second):
			t.Fatal("the runner's call went on after the caller left")
		}
		<-done
	})

	t.Run("limits", func(t *testing.T) {
		var wg sync.WaitGroup
		for range maxCallsPerUserPage {
			wg.Add(1)
			go func() {
				defer wg.Done()
				req, _ := http.NewRequest("GET", ts.URL+x+"/slow", nil)
				req.Header.Set(userHeader, "alice")
				req.Header.Set("X-Specola-Version", "1")
				if res, err := http.DefaultClient.Do(req); err == nil {
					io.Copy(io.Discard, res.Body)
					res.Body.Close()
				}
			}()
		}
		for range maxCallsPerUserPage {
			<-fr.arrived
		}
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", x+"/slow", 1, nil, nil), http.StatusTooManyRequests, "too-many-requests")
		// Another user has their own allowance.
		res := callBackend(t, ts, ctx, "viewer@example.com", "GET", x+"/ok", 1, nil, nil)
		if readBody(t, res); res.StatusCode != http.StatusCreated {
			t.Fatalf("bob while alice is at her limit: %d", res.StatusCode)
		}
		close(fr.release)
		wg.Wait()
		if res := callBackend(t, ts, ctx, "alice", "GET", x+"/ok", 1, nil, nil); res.StatusCode != http.StatusCreated {
			t.Fatalf("after the limit: %d", res.StatusCode)
		}

		// Bodies: refused by their declared length before anything is read,
		// or cut off at the limit when the length isn't declared.
		for _, size := range []int64{maxBackendBody + 1, -1} {
			req := httptest.NewRequest("POST", x+"/big", io.LimitReader(zeros{}, maxBackendBody+1))
			req.ContentLength = size
			req.Header.Set(userHeader, "alice")
			req.Header.Set("X-Specola-Version", "1")
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, req)
			if rec.Code != http.StatusRequestEntityTooLarge || rec.Header().Get("X-Specola-Error") != "body-too-large" {
				t.Fatalf("body of %d bytes: %d %s", size, rec.Code, rec.Body)
			}
		}
	})

	t.Run("logs", func(t *testing.T) {
		code, body := call(t, ts, "alice", "GET", "/api/pages/"+page+"/backend/logs?since=3", "")
		if code != http.StatusOK || !strings.Contains(body, "page="+page+" since=3") || !strings.Contains(body, `"seq":7`) {
			t.Fatalf("logs: %d %s", code, body)
		}
		if code, body := call(t, ts, "editor@example.com", "GET", "/api/pages/"+page+"/backend/logs", ""); code != http.StatusOK {
			t.Fatalf("editor's logs: %d %s", code, body)
		}
		for user, want := range map[string]int{"viewer@example.com": http.StatusForbidden, "mallory": http.StatusNotFound} {
			if code, body := call(t, ts, user, "GET", "/api/pages/"+page+"/backend/logs", ""); code != want {
				t.Fatalf("%s's logs: %d %s, want %d", user, code, body, want)
			}
		}
		if code, _ := call(t, ts, "alice", "GET", "/api/pages/"+page+"/backend/logs?since=x", ""); code != http.StatusBadRequest {
			t.Fatalf("bad since: %d", code)
		}
	})

	t.Run("versions", func(t *testing.T) {
		// A static version makes the page lose its backend.
		if code, body := call(t, ts, "alice", "POST", "/api/pages/"+page+"/versions", `{"html":"<p>static</p>"}`); code != http.StatusCreated {
			t.Fatalf("add version: %d %s", code, body)
		}
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", x+"/a", 1, nil, nil), http.StatusConflict, "superseded")
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", x+"/a", 2, nil, nil), http.StatusNotFound, "no-backend")
		// Restoring brings it back, under the new version.
		if code, body := call(t, ts, "alice", "POST", "/api/pages/"+page+"/versions", `{"restoreFrom":1}`); code != http.StatusCreated {
			t.Fatalf("restore: %d %s", code, body)
		}
		res := callBackend(t, ts, ctx, "alice", "GET", x+"/a", 3, nil, nil)
		if readBody(t, res); res.StatusCode != http.StatusCreated || fr.last(t).head.Page.Version != 3 {
			t.Fatalf("restored backend: %d", res.StatusCode)
		}
		// Archived: as if it didn't exist.
		if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+page+"/archive", ""); code != http.StatusNoContent {
			t.Fatal("archive")
		}
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", x+"/a", 3, nil, nil), http.StatusNotFound, "not-found")
	})

	t.Run("unavailable", func(t *testing.T) {
		page := publishBackendPage(t, ts)
		fr.Close()
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+page+"/x/a", 1, nil, nil),
			http.StatusServiceUnavailable, "backend-unavailable")
		if s.runner.Available() {
			t.Fatal("still available after a failed dial")
		}
		wantBackendError(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+page+"/x/a", 1, nil, nil),
			http.StatusServiceUnavailable, "backend-unavailable")
		_, body := call(t, ts, "alice", "GET", "/api/me", "")
		if !strings.Contains(body, `"backends":{"enabled":true,"available":false}`) {
			t.Fatalf("me: %s", body)
		}
		code, body := call(t, ts, "alice", "POST", "/api/bundle-uploads", `{"kind":"new","title":"X"}`)
		if code != http.StatusCreated || !strings.Contains(body, `"backend":{"enabled":true,"available":false,"reason":"the backend runner is not answering`) {
			t.Fatalf("bundle upload: %d %s", code, body)
		}
	})
}

func mustDo(t *testing.T, req *http.Request) *http.Response {
	t.Helper()
	res, err := noGzip.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

func TestBackendVersionsAndServing(t *testing.T) {
	fr := newFakeRunner(t)
	ts, _, _ := newBackendTestServer(t, fr)
	// v1 static, then v2 with a backend.
	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"Shop","html":"<p>v1</p>"}`)
	page := createdID(t, code, body)
	code, body = call(t, ts, "alice", "POST", "/api/pages/"+page+"/links", `{"version":1}`)
	if code != http.StatusCreated {
		t.Fatalf("pinned link: %d %s", code, body)
	}
	var pinned struct{ URL string }
	mustJSON(t, body, &pinned)
	// With backends on, even a static version isn't cached for good: a
	// backend version becoming current later closes it.
	if res := get(t, ts, "", "/view/"+page+"?v=1", http.Header{userHeader: {"alice"}}); res.StatusCode != http.StatusOK ||
		res.Header.Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("static v1: %d %v", res.StatusCode, res.Header)
	}
	publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"version","id":"`+page+`"}`), backendBundle, "")

	_, body = call(t, ts, "alice", "GET", "/api/pages/"+page+"/versions", "")
	var vs []struct {
		Version                   int
		Bundle, Backend, Viewable bool
	}
	mustJSON(t, body, &vs)
	if len(vs) != 2 || !vs[0].Backend || !vs[0].Viewable || vs[1].Backend || vs[1].Viewable {
		t.Fatalf("versions = %+v", vs)
	}
	_, body = call(t, ts, "alice", "GET", "/api/pages/"+page, "")
	if !strings.Contains(body, `"backend":true`) {
		t.Fatalf("meta: %s", body)
	}

	// The closed version answers 410 everywhere it is served.
	for _, path := range []string{"/view/" + page + "?v=1", strings.TrimPrefix(pinned.URL, "http://test")} {
		res := get(t, ts, "", path, http.Header{userHeader: {"alice"}})
		b := readBody(t, res)
		if res.StatusCode != http.StatusGone || res.Header.Get("X-Specola-Error") != "superseded" ||
			!strings.Contains(b, "This page has a backend: only its current version can be opened") ||
			res.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("GET %s: %d %v %s", path, res.StatusCode, res.Header, b)
		}
	}
	// The current one is served, telling the SDK it has a backend, and
	// isn't cached for good even by number: it closes when another version
	// becomes current.
	for _, path := range []string{"/view/" + page, "/view/" + page + "?v=2"} {
		res := get(t, ts, "", path, http.Header{userHeader: {"alice"}})
		b := readBody(t, res)
		if res.StatusCode != http.StatusOK || !strings.Contains(b, `"backend":true}`) || res.Header.Get("Cache-Control") != "private, no-cache" {
			t.Fatalf("GET %s: %d %v", path, res.StatusCode, res.Header)
		}
	}
	// No link can be pinned to a backend page.
	res := callBackend(t, ts, context.Background(), "alice", "POST", "/api/pages/"+page+"/links", 0, strings.NewReader(`{"version":2}`), nil)
	wantBackendError(t, res, http.StatusBadRequest, "backend-pinned")

	// The backend's files are never served nor listed.
	f := versionFiles(t, ts, "alice", page, 2)
	if len(f.Files) != 1 || f.Files[0].Path != "assets/app.js" {
		t.Fatalf("files = %+v", f.Files)
	}
	base := strings.TrimPrefix(f.Base, "http://test")
	for path, want := range map[string]int{"assets/app.js": 200, ".specola/backend.json": 404, ".specola/server/index.mjs": 404} {
		if res := get(t, ts, "", base+path, nil); res.StatusCode != want {
			t.Fatalf("GET %s: %d, want %d", path, res.StatusCode, want)
		}
	}
}

func TestRunnerCodeEndpoint(t *testing.T) {
	fr := newFakeRunner(t)
	ts, _, pool := newBackendTestServer(t, fr)
	page := publishBackendPage(t, ts)
	var versionID string
	if err := pool.QueryRow(context.Background(), `SELECT id::text FROM asset_version WHERE asset_id = $1::uuid`, page).Scan(&versionID); err != nil {
		t.Fatal(err)
	}
	code := func(auth, id string) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("GET", ts.URL+"/internal/runner/code/"+id, nil)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	for _, auth := range []string{"", "Bearer wrong", runnerToken, "Basic " + runnerToken} {
		if c, b := code(auth, versionID); c != http.StatusNotFound {
			t.Fatalf("auth %q: %d %s", auth, c, b)
		}
	}
	c, b := code("Bearer "+runnerToken, versionID)
	var got struct {
		CodeHash string
		Files    []struct {
			Path    string
			Content []byte
		}
	}
	mustJSON(t, b, &got)
	if c != http.StatusOK || len(got.CodeHash) != 64 || len(got.Files) != 2 || got.Files[0].Path != "backend.json" ||
		string(got.Files[1].Content) != backendBundle[".specola/server/index.mjs"] || !strings.Contains(b, base64.StdEncoding.EncodeToString(got.Files[1].Content)) {
		t.Fatalf("code: %d %s", c, b)
	}
	for _, id := range []string{"nope", "00000000-0000-0000-0000-000000000000"} {
		if c, _ := code("Bearer "+runnerToken, id); c != http.StatusNotFound {
			t.Fatalf("version %s: %d", id, c)
		}
	}
	// Not the SPA shell either, anywhere under /internal/.
	if c, _ := code("Bearer "+runnerToken, versionID+"/x"); c != http.StatusNotFound {
		t.Fatalf("subpath: %d", c)
	}
}

func TestBackendsDisabled(t *testing.T) {
	fr := newFakeRunner(t)
	ts, _, pool := newBackendTestServer(t, fr)
	page := publishBackendPage(t, ts)

	// The same data, on an instance without backends.
	off := httptest.NewServer(New(&config.Config{AppBaseURL: "http://test", TrustedUserHeader: userHeader}, store.New(pool), nil, nil))
	defer off.Close()
	ctx := context.Background()

	_, body := call(t, off, "alice", "GET", "/api/me", "")
	if !strings.Contains(body, `"backends":{"enabled":false,"available":false}`) {
		t.Fatalf("me: %s", body)
	}
	code, body := call(t, off, "alice", "POST", "/api/bundle-uploads", `{"kind":"new","title":"X"}`)
	if code != http.StatusCreated || !strings.Contains(body, `"backend":{"enabled":false,"available":false,"reason":"page backends are not enabled`) {
		t.Fatalf("bundle upload: %d %s", code, body)
	}
	up := mintBundle(t, off, "alice", `{"kind":"new","title":"X"}`)
	_, body = call(t, off, "", "GET", up, "")
	if !strings.Contains(body, `"backend":{"enabled":false,"available":false}`) {
		t.Fatalf("upload info: %s", body)
	}
	// A bundle with a backend is refused before anything is uploaded...
	req, _ := http.NewRequest("POST", off.URL+up+"/manifest", strings.NewReader(backendBundle.manifest("1.0.0")))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	wantBackendError(t, res, http.StatusBadRequest, "backend-disabled")
	// ...after the link's own errors.
	if code, _ := send(t, off, "POST", "/upload/bundle/nope/manifest", []byte(backendBundle.manifest("1.0.0"))); code != http.StatusNotFound {
		t.Fatalf("unknown link: %d", code)
	}
	// A static bundle is fine.
	static := files{"index.html": "<p>x</p>"}
	if code, body := send(t, off, "POST", up+"/manifest", []byte(static.manifest("1.0.0"))); code != http.StatusOK {
		t.Fatalf("static manifest: %d %s", code, body)
	}

	// A page published with a backend still opens, without one to call.
	res = get(t, off, "", "/view/"+page, http.Header{userHeader: {"alice"}})
	if b := readBody(t, res); res.StatusCode != http.StatusOK || !strings.Contains(b, `"backend":false}`) {
		t.Fatalf("view: %d %s", res.StatusCode, b)
	}
	// And the ETag tells the two apart.
	on := get(t, ts, "", "/view/"+page, http.Header{userHeader: {"alice"}})
	if on.Header.Get("ETag") == res.Header.Get("ETag") {
		t.Fatal("same ETag with and without backends")
	}
	wantBackendError(t, callBackend(t, off, ctx, "alice", "GET", "/api/pages/"+page+"/x/a", 1, nil, nil),
		http.StatusServiceUnavailable, "backend-disabled")
	code, body = call(t, off, "alice", "GET", "/api/pages/"+page+"/backend/logs", "")
	if code != http.StatusServiceUnavailable || !strings.Contains(body, "backend-disabled") {
		t.Fatalf("logs: %d %s", code, body)
	}
	if code, _ := call(t, off, "", "GET", "/internal/runner/code/x", ""); code != http.StatusNotFound {
		t.Fatalf("code endpoint: %d", code)
	}
}

func TestBackendPathsAreNotCompressedOrRouted(t *testing.T) {
	for p, want := range map[string]bool{
		"/api/pages/abc/x": true, "/api/pages/abc/x/": true, "/api/pages/abc/x/a/b": true,
		"/api/pages/abc/xy": false, "/api/pages/abc/data": false, "/api/pages/x": false, "/view/abc/x": false,
	} {
		if isBackendCall(p) != want {
			t.Errorf("isBackendCall(%q) = %v", p, !want)
		}
	}
}

func TestBackendOnViewOrigin(t *testing.T) {
	fr := newFakeRunner(t)
	pool := testdb.New(t)
	cfg := backendConfig(fr.URL)
	cfg.ViewOrigin, cfg.SessionSecret = "http://view.test", "secret"
	s := New(cfg, store.New(pool), nil, nil)
	s.runner.Check(context.Background())
	ts := httptest.NewServer(s)
	defer ts.Close()

	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"Shop","html":"<p>v1</p>"}`)
	page := createdID(t, code, body)
	publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"version","id":"`+page+`"}`), backendBundle, "")
	token := s.tokens.mint("alice", page, time.Now())
	for v, want := range map[string]int{"1": http.StatusGone, "2": http.StatusOK} {
		res := get(t, ts, "view.test", "/t/"+token+"/view/"+page+"?v="+v, nil)
		readBody(t, res)
		if res.StatusCode != want || res.Header.Get("Access-Control-Allow-Origin") != "http://test" {
			t.Fatalf("v%s: %d %v, want %d", v, res.StatusCode, res.Header, want)
		}
	}
	// The runner's API is not on the view origin, nor are backend calls.
	if res := get(t, ts, "view.test", "/internal/runner/code/x", http.Header{"Authorization": {"Bearer " + runnerToken}}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("code on the view origin: %d", res.StatusCode)
	}
	if res := get(t, ts, "view.test", "/api/pages/"+page+"/x/a", http.Header{userHeader: {"alice"}, "X-Specola-Version": {"2"}}); res.StatusCode != http.StatusNotFound {
		t.Fatalf("backend call on the view origin: %d", res.StatusCode)
	}
	res := callBackend(t, ts, context.Background(), "alice", "GET", "/api/pages/"+page+"/x/a", 2, nil, nil)
	if readBody(t, res); res.StatusCode != http.StatusCreated {
		t.Fatalf("backend call on the app origin: %d", res.StatusCode)
	}
}
