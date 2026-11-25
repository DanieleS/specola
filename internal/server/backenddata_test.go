package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
)

// fakeData is the fake runner's side of the data routes: it records the
// requests and answers as the runner would.
type fakeData struct {
	mu    sync.Mutex
	calls []dataCall
	// holdExport: an export sends its first chunk, then waits for
	// exportNext.
	holdExport atomic.Bool
	exportNext chan struct{}
	// importArrived gets the first bytes of each import as they arrive.
	importArrived chan string
	// broken: every data route fails without an error code.
	broken atomic.Bool
	// purgeFail: DELETE /pages/{id} fails.
	purgeFail atomic.Bool
}

type dataCall struct {
	method, path, sub, ctype, body string
	query, version                 string
	size                           int64
}

func (d *fakeData) init() {
	d.exportNext = make(chan struct{})
	d.importArrived = make(chan string, 10)
}

func (d *fakeData) record(c dataCall) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.calls = append(d.calls, c)
}

func (d *fakeData) last(t *testing.T) dataCall {
	t.Helper()
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.calls) == 0 {
		t.Fatal("the runner got no data request")
	}
	return d.calls[len(d.calls)-1]
}

func (d *fakeData) count() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return len(d.calls)
}

func runnerError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("X-Specola-Error", code)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":%q,"message":"from the runner"}`, code)
}

const snapshotJSON = `{"id":"20260101T000000Z-%s","kind":"%s","createdAt":"2026-01-01T00:00:00Z","sizeBytes":10}`

func (fr *fakeRunner) serveData(w http.ResponseWriter, r *http.Request) {
	d := &fr.data
	c := dataCall{method: r.Method, path: r.URL.EscapedPath(), sub: r.Header.Get("X-Specola-Sub"), ctype: r.Header.Get("Content-Type"),
		query: r.URL.RawQuery, version: r.Header.Get("X-Specola-Version")}
	_, rest, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, "/pages/"), "/")
	route := r.Method + " " + rest
	if route == "PUT import" {
		// Read as it comes, telling the test about the first bytes.
		buf := make([]byte, 64<<10)
		n, _ := io.ReadAtLeast(r.Body, buf, 1)
		select {
		case d.importArrived <- string(buf[:n]):
		default:
		}
		more, err := io.Copy(io.Discard, r.Body)
		if err != nil {
			return
		}
		c.size = int64(n) + more
		if c.size < 1<<10 {
			c.body = string(buf[:n])
		}
	} else {
		b, _ := io.ReadAll(r.Body)
		c.body, c.size = string(b), int64(len(b))
	}
	d.record(c)
	if d.broken.Load() {
		http.Error(w, "boom", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch {
	case route == "GET data":
		io.WriteString(w, `{"usage":{"pageBytes":1,"pageLimit":2,"snapshotBytes":3,"snapshotLimit":4},"snapshots":[`+fmt.Sprintf(snapshotJSON, "daily", "daily")+`]}`)
	case route == "POST snapshots":
		if strings.Contains(c.body, `"label":"full"`) {
			runnerError(w, http.StatusConflict, "too-many-snapshots")
			return
		}
		w.WriteHeader(http.StatusCreated)
		fmt.Fprintf(w, snapshotJSON, "manual", "manual")
	case r.Method == "DELETE" && strings.HasPrefix(rest, "snapshots/"):
		if !strings.HasSuffix(rest, "-manual") {
			runnerError(w, http.StatusConflict, "not-manual")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case r.Method == "POST" && strings.HasSuffix(rest, "/restore"):
		fmt.Fprintf(w, `{"before":`+snapshotJSON+`}`, "before-restore", "before-restore")
	case route == "GET export":
		w.Header().Set("Content-Type", "application/octet-stream")
		io.WriteString(w, "PK-one|")
		w.(http.Flusher).Flush()
		if d.holdExport.Load() {
			select {
			case <-d.exportNext:
			case <-r.Context().Done():
				return
			}
		}
		io.WriteString(w, "PK-two")
	case route == "PUT import":
		if strings.HasPrefix(c.body, "bad") {
			runnerError(w, http.StatusBadRequest, "bad-import")
			return
		}
		fmt.Fprintf(w, `{"before":`+snapshotJSON+`}`, "before-import", "before-import")
	case route == "POST wipe":
		fmt.Fprintf(w, `{"before":`+snapshotJSON+`}`, "before-wipe", "before-wipe")
	case route == "GET my-data":
		if c.sub == "nodata@example.com" {
			runnerError(w, http.StatusNotFound, "no-data")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		io.WriteString(w, "SQLite format 3\x00"+c.sub)
	case route == "DELETE my-data":
		w.WriteHeader(http.StatusNoContent)
	case r.Method == "DELETE" && rest == "":
		if d.purgeFail.Load() {
			runnerError(w, http.StatusServiceUnavailable, "backend-unavailable")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		runnerError(w, http.StatusNotFound, "not-found")
	}
}

// dataReq sends a request to a data route as user.
func dataReq(t *testing.T, ts *httptest.Server, user, method, path string, body io.Reader, h http.Header) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range h {
		req.Header[k] = v
	}
	if user != "" {
		req.Header.Set(userHeader, user)
	}
	return mustDo(t, req)
}

var zipType = http.Header{"Content-Type": {"application/zip"}}

func TestBackendDataRoutes(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, _ := newBackendTestServer(t, fr)
	page := publishBackendPage(t, ts)
	for user, role := range map[string]string{"viewer@example.com": "viewer", "editor@example.com": "editor", "nodata@example.com": "viewer"} {
		if code, body := call(t, ts, "alice", "PUT", "/api/pages/"+page+"/acl", `{"sub":"`+user+`","role":"`+role+`"}`); code != http.StatusNoContent {
			t.Fatalf("share: %d %s", code, body)
		}
	}
	// Any spelling of the page's id: the runner gets the canonical one.
	b := "/api/pages/" + strings.ToUpper(page) + "/backend"
	at := "/pages/" + page

	t.Run("roles", func(t *testing.T) {
		const sid = "/snapshots/20260101T000000Z-manual"
		for _, r := range []struct {
			method, path, body string
			h                  http.Header
			ok                 int
			runner             string // the runner's path
			who                []string
		}{
			{"GET", "/data", "", nil, 200, at + "/data", []string{"alice", "editor@example.com"}},
			{"POST", "/snapshots", `{"label":"before the migration"}`, nil, 201, at + "/snapshots", []string{"alice"}},
			{"DELETE", sid, "", nil, 204, at + sid, []string{"alice"}},
			{"POST", sid + "/restore", "", nil, 200, at + sid + "/restore", []string{"alice"}},
			{"GET", "/export", "", nil, 200, at + "/export", []string{"alice", "editor@example.com"}},
			{"PUT", "/import", "PK zip", zipType, 200, at + "/import", []string{"alice"}},
			{"POST", "/wipe", `{"scope":"shared"}`, nil, 200, at + "/wipe", []string{"alice"}},
			{"GET", "/my-data", "", nil, 200, at + "/my-data", []string{"alice", "editor@example.com", "viewer@example.com"}},
			{"DELETE", "/my-data", "", nil, 204, at + "/my-data", []string{"alice", "editor@example.com", "viewer@example.com"}},
		} {
			for _, user := range []string{"alice", "editor@example.com", "viewer@example.com", "mallory"} {
				before := fr.data.count()
				res := dataReq(t, ts, user, r.method, b+r.path, strings.NewReader(r.body), r.h)
				switch {
				case user == "mallory":
					wantBackendError(t, res, http.StatusNotFound, "not-found")
				case !strings.Contains(strings.Join(r.who, ","), user):
					wantBackendError(t, res, http.StatusForbidden, "forbidden")
				default:
					body := readBody(t, res)
					if res.StatusCode != r.ok || res.Header.Get("Cache-Control") != "private, no-store" {
						t.Fatalf("%s %s as %s: %d %s", r.method, r.path, user, res.StatusCode, body)
					}
					c := fr.data.last(t)
					if c.method != r.method || c.path != r.runner {
						t.Fatalf("%s %s: the runner got %s %s", r.method, r.path, c.method, c.path)
					}
					// Only a user's own data names them to the runner.
					if mine := strings.HasSuffix(r.path, "/my-data"); (c.sub == user) != mine || (!mine && c.sub != "") {
						t.Fatalf("%s %s as %s: X-Specola-Sub %q", r.method, r.path, user, c.sub)
					}
					continue
				}
				if fr.data.count() != before {
					t.Fatalf("%s %s as %s reached the runner", r.method, r.path, user)
				}
			}
		}
	})

	t.Run("bodies", func(t *testing.T) {
		code, body := call(t, ts, "alice", "GET", b+"/data", "")
		if code != 200 || !strings.Contains(body, `"snapshotLimit":4`) || !strings.Contains(body, `"kind":"daily"`) {
			t.Fatalf("data: %d %s", code, body)
		}
		// The label is trimmed and sent as the runner wants it.
		label := strings.Repeat("é", 100)
		res := dataReq(t, ts, "alice", "POST", b+"/snapshots", strings.NewReader(`{"label":"  `+label+` "}`), nil)
		if readBody(t, res); res.StatusCode != http.StatusCreated || fr.data.last(t).body != `{"kind":"manual","label":"`+label+`"}` {
			t.Fatalf("snapshot: %d %q", res.StatusCode, fr.data.last(t).body)
		}
		if c := fr.data.last(t); c.ctype != "application/json" {
			t.Fatalf("snapshot type %q", c.ctype)
		}
		res = dataReq(t, ts, "alice", "POST", b+"/wipe", strings.NewReader(`{"scope":"users"}`), nil)
		if body := readBody(t, res); res.StatusCode != 200 || !strings.Contains(body, `"before":{"id":"20260101T000000Z-before-wipe"`) ||
			fr.data.last(t).body != `{"scope":"users"}` {
			t.Fatalf("wipe: %d %s", res.StatusCode, body)
		}
		res = dataReq(t, ts, "alice", "POST", b+"/snapshots/20260101T000000Z-version-v1/restore", nil, nil)
		if body := readBody(t, res); res.StatusCode != 200 || !strings.Contains(body, `"kind":"before-restore"`) {
			t.Fatalf("restore: %d %s", res.StatusCode, body)
		}
		// With the page's current version: the runner restores the data
		// for it when it hasn't run it yet.
		if c := fr.data.last(t); c.version != "1" {
			t.Fatalf("restore sent X-Specola-Version %q", c.version)
		}
	})

	t.Run("refused before the runner", func(t *testing.T) {
		before := fr.data.count()
		for _, r := range []struct {
			method, path, body string
			h                  http.Header
			status             int
			code               string
		}{
			{"POST", "/snapshots", `{"label":""}`, nil, 400, "bad-request"},
			{"POST", "/snapshots", `{"label":"   "}`, nil, 400, "bad-request"},
			{"POST", "/snapshots", `{"label":"` + strings.Repeat("x", 101) + `"}`, nil, 400, "bad-request"},
			{"POST", "/snapshots", `not json`, nil, 400, "bad-request"},
			{"POST", "/wipe", `{"scope":"everything"}`, nil, 400, "bad-request"},
			{"POST", "/wipe", `{}`, nil, 400, "bad-request"},
			{"DELETE", "/snapshots/latest", "", nil, 404, "not-found"},
			{"POST", "/snapshots/..%2F..%2Fx/restore", "", nil, 404, "not-found"},
			{"PUT", "/import", "PK", nil, 400, "bad-import"},
			{"PUT", "/import", "PK", http.Header{"Content-Type": {"text/plain"}}, 400, "bad-import"},
		} {
			wantBackendError(t, dataReq(t, ts, "alice", r.method, b+r.path, strings.NewReader(r.body), r.h), r.status, r.code)
		}
		if fr.data.count() != before {
			t.Fatal("a refused request reached the runner")
		}
		// Too large by its declared length: refused before anything is read.
		req := httptest.NewRequest("PUT", b+"/import", io.LimitReader(zeros{}, 10))
		req.ContentLength = maxImportBytes + 1
		req.Header.Set("Content-Type", "application/zip")
		req.Header.Set(userHeader, "alice")
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge || rec.Header().Get("X-Specola-Error") != "body-too-large" || fr.data.count() != before {
			t.Fatalf("declared too large: %d %s", rec.Code, rec.Body)
		}
	})

	t.Run("runner errors pass through", func(t *testing.T) {
		wantRunnerError := func(res *http.Response, status int, code string) {
			t.Helper()
			body := readBody(t, res)
			if res.StatusCode != status || res.Header.Get("X-Specola-Error") != code || !strings.Contains(body, "from the runner") {
				t.Fatalf("got %d %q %s, want %d %s", res.StatusCode, res.Header.Get("X-Specola-Error"), body, status, code)
			}
		}
		wantRunnerError(dataReq(t, ts, "alice", "POST", b+"/snapshots", strings.NewReader(`{"label":"full"}`), nil), 409, "too-many-snapshots")
		wantRunnerError(dataReq(t, ts, "alice", "DELETE", b+"/snapshots/20260101T000000Z-daily", nil, nil), 409, "not-manual")
		wantRunnerError(dataReq(t, ts, "alice", "PUT", b+"/import", strings.NewReader("bad zip"), zipType), 400, "bad-import")
		res := dataReq(t, ts, "nodata@example.com", "GET", b+"/my-data", nil, nil)
		if wantRunnerError(res, 404, "no-data"); res.Header.Get("Content-Disposition") != "" {
			t.Fatal("an error is offered as a download")
		}
		// A failure without a code is the runner breaking the contract.
		fr.data.broken.Store(true)
		defer fr.data.broken.Store(false)
		wantBackendError(t, dataReq(t, ts, "alice", "GET", b+"/data", nil, nil), http.StatusBadGateway, "backend-crashed")
	})

	t.Run("export streams", func(t *testing.T) {
		fr.data.holdExport.Store(true)
		defer fr.data.holdExport.Store(false)
		res := dataReq(t, ts, "editor@example.com", "GET", b+"/export", nil, http.Header{"Accept-Encoding": {"gzip"}})
		if res.StatusCode != 200 || res.Header.Get("Content-Type") != "application/zip" ||
			res.Header.Get("Content-Disposition") != `attachment; filename=Shop-data.zip` || res.Header.Get("Content-Encoding") != "" {
			t.Fatalf("export: %d %v", res.StatusCode, res.Header)
		}
		rd := bufio.NewReader(res.Body)
		first, err := rd.ReadString('|')
		if err != nil || first != "PK-one|" {
			t.Fatalf("first chunk %q %v", first, err)
		}
		// The manifest says the page as specola has it.
		if c := fr.data.last(t); c.query != "title=Shop&version=1" {
			t.Fatalf("export query %q", c.query)
		}
		// Only now does the runner send the rest: the first chunk came alone.
		fr.data.exportNext <- struct{}{}
		if rest, _ := io.ReadAll(rd); string(rest) != "PK-two" {
			t.Fatalf("rest %q", rest)
		}
	})

	t.Run("transfers per user and page are bounded", func(t *testing.T) {
		fr.data.holdExport.Store(true)
		defer fr.data.holdExport.Store(false)
		var held []*http.Response
		for range maxTransfersPerUserPage {
			res := dataReq(t, ts, "editor@example.com", "GET", b+"/export", nil, nil)
			if res.StatusCode != 200 {
				t.Fatalf("export: %d", res.StatusCode)
			}
			held = append(held, res)
		}
		wantBackendError(t, dataReq(t, ts, "editor@example.com", "GET", b+"/export", nil, nil), http.StatusTooManyRequests, "too-many-requests")
		wantBackendError(t, dataReq(t, ts, "editor@example.com", "GET", b+"/my-data", nil, nil), http.StatusTooManyRequests, "too-many-requests")
		// Someone else's aren't held back, nor the editor's calls.
		if res := dataReq(t, ts, "viewer@example.com", "GET", b+"/my-data", nil, nil); readBody(t, res) == "" || res.StatusCode != 200 {
			t.Fatalf("another user's download: %d", res.StatusCode)
		}
		for _, res := range held {
			fr.data.exportNext <- struct{}{}
			readBody(t, res)
		}
		if res := dataReq(t, ts, "editor@example.com", "GET", b+"/my-data", nil, nil); readBody(t, res) == "" || res.StatusCode != 200 {
			t.Fatalf("after: %d", res.StatusCode)
		}
	})

	t.Run("my data", func(t *testing.T) {
		res := dataReq(t, ts, "viewer@example.com", "GET", b+"/my-data", nil, http.Header{"Accept-Encoding": {"gzip"}})
		body := readBody(t, res)
		if res.StatusCode != 200 || body != "SQLite format 3\x00viewer@example.com" || res.Header.Get("Content-Type") != "application/vnd.sqlite3" ||
			res.Header.Get("Content-Disposition") != `attachment; filename=Shop-my-data.sqlite` || res.Header.Get("Content-Encoding") != "" {
			t.Fatalf("my data: %d %v %q", res.StatusCode, res.Header, body)
		}
	})

	t.Run("import streams", func(t *testing.T) {
		// The zip reaches the runner while the caller is still sending it,
		// with no length declared: nothing waits for the whole of it.
		for len(fr.data.importArrived) > 0 {
			<-fr.data.importArrived
		}
		pr, pw := io.Pipe()
		done := make(chan *http.Response)
		go func() {
			req, _ := http.NewRequest("PUT", ts.URL+b+"/import", pr)
			req.Header.Set("Content-Type", "application/zip")
			req.Header.Set(userHeader, "alice")
			res, err := noGzip.Do(req)
			if err != nil {
				t.Error(err)
			}
			done <- res
		}()
		if _, err := pw.Write([]byte("PK first part")); err != nil {
			t.Fatal(err)
		}
		select {
		case first := <-fr.data.importArrived:
			if first != "PK first part" {
				t.Fatalf("first bytes %q", first)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the zip is held back until it is whole")
		}
		pw.Write([]byte(strings.Repeat("z", 1<<20)))
		pw.Close()
		res := <-done
		if body := readBody(t, res); res.StatusCode != 200 || !strings.Contains(body, `"kind":"before-import"`) {
			t.Fatalf("import: %d %s", res.StatusCode, body)
		}
		if c := fr.data.last(t); c.size != int64(len("PK first part"))+1<<20 || c.ctype != "application/zip" {
			t.Fatalf("the runner got %d bytes as %q", c.size, c.ctype)
		}
		// Windows names a zip so.
		res = dataReq(t, ts, "alice", "PUT", b+"/import", strings.NewReader("PK"), http.Header{"Content-Type": {"application/x-zip-compressed"}})
		if readBody(t, res); res.StatusCode != 200 {
			t.Fatalf("x-zip-compressed: %d", res.StatusCode)
		}
	})

	t.Run("import over the limit", func(t *testing.T) {
		if testing.Short() {
			t.Skip("sends a GiB")
		}
		// No length declared: cut off at the limit.
		req, _ := http.NewRequest("PUT", ts.URL+b+"/import", io.LimitReader(zeros{}, maxImportBytes+1))
		req.Header.Set("Content-Type", "application/zip")
		req.Header.Set(userHeader, "alice")
		res := mustDo(t, req)
		wantBackendError(t, res, http.StatusRequestEntityTooLarge, "body-too-large")
	})

	t.Run("dormant page", func(t *testing.T) {
		// A static version: the data stays, and so do these routes.
		if code, body := call(t, ts, "alice", "POST", "/api/pages/"+page+"/versions", `{"html":"<p>static</p>"}`); code != http.StatusCreated {
			t.Fatalf("add version: %d %s", code, body)
		}
		if code, body := call(t, ts, "alice", "GET", b+"/data", ""); code != 200 {
			t.Fatalf("data of a dormant page: %d %s", code, body)
		}
		// Archived: out of reach, like the page.
		if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+page+"/archive", ""); code != http.StatusNoContent {
			t.Fatal("archive")
		}
		wantBackendError(t, dataReq(t, ts, "alice", "GET", b+"/data", nil, nil), http.StatusNotFound, "not-found")
		wantBackendError(t, dataReq(t, ts, "viewer@example.com", "GET", b+"/my-data", nil, nil), http.StatusNotFound, "not-found")
		if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+page+"/unarchive", ""); code != http.StatusNoContent {
			t.Fatal("unarchive")
		}
	})

	t.Run("unavailable", func(t *testing.T) {
		s.runner.MarkUnavailable()
		wantBackendError(t, dataReq(t, ts, "alice", "GET", b+"/data", nil, nil), http.StatusServiceUnavailable, "backend-unavailable")
		// Access comes first.
		wantBackendError(t, dataReq(t, ts, "mallory", "GET", b+"/data", nil, nil), http.StatusNotFound, "not-found")
		wantBackendError(t, dataReq(t, ts, "viewer@example.com", "GET", b+"/data", nil, nil), http.StatusForbidden, "forbidden")
		// A runner gone away is found out by the request itself.
		s.runner.Check(context.Background())
		fr.Close()
		wantBackendError(t, dataReq(t, ts, "alice", "GET", b+"/export", nil, nil), http.StatusServiceUnavailable, "backend-unavailable")
		if s.runner.Available() {
			t.Fatal("still available after a failed dial")
		}
	})
}

func TestBackendDataDisabled(t *testing.T) {
	fr := newFakeRunner(t)
	ts, _, pool := newBackendTestServer(t, fr)
	page := publishBackendPage(t, ts)
	off := httptest.NewServer(New(&config.Config{AppBaseURL: "http://test", TrustedUserHeader: userHeader}, store.New(pool), nil, nil))
	defer off.Close()
	b := "/api/pages/" + page + "/backend"
	for _, r := range [][2]string{{"GET", "/data"}, {"GET", "/export"}, {"GET", "/my-data"}, {"DELETE", "/my-data"}, {"POST", "/wipe"}} {
		wantBackendError(t, dataReq(t, off, "alice", r[0], b+r[1], nil, nil), http.StatusServiceUnavailable, "backend-disabled")
		wantBackendError(t, dataReq(t, off, "mallory", r[0], b+r[1], nil, nil), http.StatusNotFound, "not-found")
	}
	if fr.data.count() != 0 {
		t.Fatal("a disabled instance asked the runner")
	}
}

func TestBackendDownloadsAreNotCompressed(t *testing.T) {
	for p, want := range map[string]bool{
		"/api/pages/abc/backend/export": true, "/api/pages/abc/backend/my-data": true,
		"/api/pages/abc/backend/data": false, "/api/pages/abc/backend/exports": false, "/api/pages/backend/export": false,
	} {
		if isBackendDownload(p) != want {
			t.Errorf("isBackendDownload(%q) = %v", p, !want)
		}
	}
	for name, want := range map[string]string{
		"Shop-data.zip":        `attachment; filename=Shop-data.zip`,
		`My "shop"/x-data.zip`: `attachment; filename="My _shop__x-data.zip"`,
		"Città-data.zip":       `attachment; filename*=utf-8''Citt%C3%A0-data.zip`,
		"a\r\nb.zip":           `attachment; filename=a__b.zip`,
	} {
		if got := attachment(name); got != want {
			t.Errorf("attachment(%q) = %s, want %s", name, got, want)
		}
	}
}

// pageMeta reads GET /api/pages/{id}'s backend fields.
func pageMeta(t *testing.T, ts *httptest.Server, user, id string) (data bool, purgeAt *time.Time) {
	t.Helper()
	code, body := call(t, ts, user, "GET", "/api/pages/"+id, "")
	if code != http.StatusOK {
		t.Fatalf("meta: %d %s", code, body)
	}
	var m struct {
		BackendData    *bool      `json:"backendData"`
		BackendPurgeAt *time.Time `json:"backendPurgeAt"`
	}
	mustJSON(t, body, &m)
	if m.BackendData == nil {
		t.Fatalf("meta without backendData: %s", body)
	}
	return *m.BackendData, m.BackendPurgeAt
}

func TestBackendDataMarks(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, pool := newBackendTestServer(t, fr)
	ctx := context.Background()
	usedAt := func(id string) *time.Time {
		t.Helper()
		var at *time.Time
		if err := pool.QueryRow(ctx, `SELECT backend_used_at FROM asset WHERE id = $1::uuid`, id).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}

	page := publishBackendPage(t, ts)
	if data, _ := pageMeta(t, ts, "alice", page); data {
		t.Fatal("backend data before any call")
	}
	// specola's and the runner's own errors don't count as the page in use.
	readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+page+"/x/a", 2, nil, nil))
	readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+page+"/x/error", 1, nil, nil))
	if usedAt(page) != nil {
		t.Fatal("an error marked the page as used")
	}
	// Any answer of the handler does.
	readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+page+"/x/a", 1, nil, nil))
	first := usedAt(page)
	if first == nil {
		t.Fatal("not marked after a call")
	}
	if data, purgeAt := pageMeta(t, ts, "alice", page); !data || purgeAt != nil {
		t.Fatalf("meta: data %v, purge %v", data, purgeAt)
	}

	// Within the hour this process doesn't even ask; past it, it does.
	old := time.Now().Add(-3 * time.Hour)
	if _, err := pool.Exec(ctx, `UPDATE asset SET backend_used_at = $2 WHERE id = $1::uuid`, page, old); err != nil {
		t.Fatal(err)
	}
	readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+page+"/x/a", 1, nil, nil))
	if !usedAt(page).Equal(old.Truncate(time.Microsecond)) {
		t.Fatalf("marked again within the hour: %v", usedAt(page))
	}
	s.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+page+"/x/a", 1, nil, nil))
	if !usedAt(page).After(old.Add(time.Hour)) {
		t.Fatalf("not marked again after the hour: %v", usedAt(page))
	}

	// An import onto a page that never ran marks it too: it has data now.
	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"Seeded","html":"<p>x</p>"}`)
	seeded := createdID(t, code, body)
	res := dataReq(t, ts, "alice", "PUT", "/api/pages/"+seeded+"/backend/import", strings.NewReader("PK"), zipType)
	if readBody(t, res); res.StatusCode != 200 || usedAt(seeded) == nil {
		t.Fatalf("import: %d, used %v", res.StatusCode, usedAt(seeded))
	}
}

func TestBackendPurgeDates(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, pool := newBackendTestServer(t, fr)
	ctx := context.Background()
	s.cfg.BackendPurgeAfterDays = 30

	page := publishBackendPage(t, ts)
	readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+page+"/x/a", 1, nil, nil))
	if _, purgeAt := pageMeta(t, ts, "alice", page); purgeAt != nil {
		t.Fatalf("a live page has a purge date: %v", purgeAt)
	}
	// Static from day 0.
	if code, body := call(t, ts, "alice", "POST", "/api/pages/"+page+"/versions", `{"html":"<p>static</p>"}`); code != http.StatusCreated {
		t.Fatalf("add version: %d %s", code, body)
	}
	day0 := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `UPDATE asset_version SET created_at = $2 WHERE asset_id = $1::uuid AND version = 2`, page, day0); err != nil {
		t.Fatal(err)
	}
	purge := day0.AddDate(0, 0, 30)
	for days, want := range map[int]bool{0: false, 22: false, 23: true, 29: true, 40: true} {
		s.now = func() time.Time { return day0.AddDate(0, 0, days).Add(time.Minute) }
		_, purgeAt := pageMeta(t, ts, "alice", page)
		if want != (purgeAt != nil) || (purgeAt != nil && !purgeAt.Equal(purge)) {
			t.Fatalf("day %d: purge at %v", days, purgeAt)
		}
	}
	// Told only where a purge can happen.
	s.cfg.BackendPurgeAfterDays = 0
	if _, purgeAt := pageMeta(t, ts, "alice", page); purgeAt != nil {
		t.Fatal("a purge date without a purge setting")
	}
	s.cfg.BackendPurgeAfterDays = 30

	// Archived on day 10: its date moves, and the Archived list tells it.
	if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+page+"/archive", ""); code != http.StatusNoContent {
		t.Fatal("archive")
	}
	if _, err := pool.Exec(ctx, `UPDATE asset SET archived_at = $2 WHERE id = $1::uuid`, page, day0.AddDate(0, 0, 10)); err != nil {
		t.Fatal(err)
	}
	other, _, err := store.New(pool).CreatePage(ctx, nil, "Plain", "<p>x</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+other+"/archive", ""); code != http.StatusNoContent {
		t.Fatal("archive")
	}
	s.now = func() time.Time { return day0.AddDate(0, 0, 35) }
	_, body := call(t, ts, "alice", "GET", "/api/archived", "")
	var items []struct {
		ID             string
		Kind           string
		BackendPurgeAt *time.Time
	}
	mustJSON(t, body, &items)
	if len(items) != 2 {
		t.Fatalf("archived: %s", body)
	}
	for _, it := range items {
		want := it.ID == page
		if (it.BackendPurgeAt != nil) != want || (want && !it.BackendPurgeAt.Equal(day0.AddDate(0, 0, 40))) {
			t.Fatalf("archived %s: purge at %v", it.ID, it.BackendPurgeAt)
		}
	}
	s.now = func() time.Time { return day0.AddDate(0, 0, 30) }
	if _, body := call(t, ts, "alice", "GET", "/api/archived", ""); strings.Contains(body, "backendPurgeAt") {
		t.Fatalf("archived, more than a week ahead: %s", body)
	}
}

// A page archived through its folder is purged too: it isn't listed and
// can't be opened, so the archived folder carries the first purge date
// among the pages inside it, at any depth.
func TestBackendPurgeDateInArchivedFolder(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, pool := newBackendTestServer(t, fr)
	ctx := context.Background()
	s.cfg.BackendPurgeAfterDays = 30

	code, body := call(t, ts, "alice", "POST", "/api/folders", `{"name":"F"}`)
	folder := createdID(t, code, body)
	code, body = call(t, ts, "alice", "POST", "/api/folders", `{"name":"G","parentId":"`+folder+`"}`)
	inner := createdID(t, code, body)
	early, late := publishBackendPage(t, ts), publishBackendPage(t, ts)
	plain, _, err := store.New(pool).CreatePage(ctx, nil, "Plain", "<p>x</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{early, late} {
		readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+p+"/x/a", 1, nil, nil))
	}
	// late is archived itself after the folder: its own date is later.
	day0 := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE asset SET folder_id = $1::uuid WHERE id = ANY($2::uuid[])`, []any{inner, []string{early, late, plain}}},
		{`UPDATE folder SET archived_at = $2 WHERE id = $1::uuid`, []any{folder, day0}},
		{`UPDATE asset SET archived_at = $2 WHERE id = $1::uuid`, []any{late, day0.AddDate(0, 0, 5)}},
	} {
		if _, err := pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	archived := func() map[string]*time.Time {
		_, body := call(t, ts, "alice", "GET", "/api/archived", "")
		var items []struct {
			ID             string
			BackendPurgeAt *time.Time
		}
		mustJSON(t, body, &items)
		out := map[string]*time.Time{}
		for _, it := range items {
			out[it.ID] = it.BackendPurgeAt
		}
		return out
	}
	s.now = func() time.Time { return day0.AddDate(0, 0, 25) }
	got := archived()
	if len(got) != 1 || got[folder] == nil || !got[folder].Equal(day0.AddDate(0, 0, 30)) {
		t.Fatalf("archived folder: %v", got)
	}
	// Further than a week ahead: nothing yet.
	s.now = func() time.Time { return day0.AddDate(0, 0, 20) }
	if got := archived(); got[folder] != nil {
		t.Fatalf("a week early: %v", got[folder])
	}
	// No pages with data inside: no date.
	if _, err := pool.Exec(ctx, `UPDATE asset SET backend_used_at = NULL WHERE id = ANY($1::uuid[])`, []string{early, late}); err != nil {
		t.Fatal(err)
	}
	s.now = func() time.Time { return day0.AddDate(0, 0, 25) }
	if got := archived(); got[folder] != nil {
		t.Fatalf("no data inside: %v", got[folder])
	}
}

func TestBackendPurgeLoop(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, pool := newBackendTestServer(t, fr)
	ctx := context.Background()
	slog.SetLogLoggerLevel(slog.LevelWarn)
	defer slog.SetLogLoggerLevel(slog.LevelInfo)

	live := publishBackendPage(t, ts)
	dormant := publishBackendPage(t, ts)
	for _, p := range []string{live, dormant} {
		readBody(t, callBackend(t, ts, ctx, "alice", "GET", "/api/pages/"+p+"/x/a", 1, nil, nil))
	}
	if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+dormant+"/archive", ""); code != http.StatusNoContent {
		t.Fatal("archive")
	}
	var archivedAt time.Time
	if err := pool.QueryRow(ctx, `SELECT archived_at FROM asset WHERE id = $1::uuid`, dormant).Scan(&archivedAt); err != nil {
		t.Fatal(err)
	}
	purged := func() []string {
		fr.data.mu.Lock()
		defer fr.data.mu.Unlock()
		var out []string
		for _, c := range fr.data.calls {
			if c.method == "DELETE" && strings.Count(c.path, "/") == 2 {
				out = append(out, strings.TrimPrefix(c.path, "/pages/"))
			}
		}
		return out
	}
	used := func(id string) bool {
		var on bool
		if err := pool.QueryRow(ctx, `SELECT backend_used_at IS NOT NULL FROM asset WHERE id = $1::uuid`, id).Scan(&on); err != nil {
			t.Fatal(err)
		}
		return on
	}

	s.cfg.BackendPurgeAfterDays = 7
	// Not yet due.
	s.now = func() time.Time { return archivedAt.AddDate(0, 0, 7).Add(-time.Minute) }
	if n := s.purgeDormant(ctx); n != 0 || len(purged()) != 0 {
		t.Fatalf("purged early: %d %v", n, purged())
	}
	s.now = func() time.Time { return archivedAt.AddDate(0, 0, 7).Add(time.Minute) }
	// The runner unavailable: nothing is tried.
	s.runner.MarkUnavailable()
	if n := s.purgeDormant(ctx); n != 0 || len(purged()) != 0 {
		t.Fatalf("purged with the runner unavailable: %d", n)
	}
	s.runner.Check(ctx)
	// The runner fails: the data and its mark stay, for the next round.
	fr.data.purgeFail.Store(true)
	if n := s.purgeDormant(ctx); n != 0 || len(purged()) != 1 || !used(dormant) {
		t.Fatalf("failed purge: %d %v %v", n, purged(), used(dormant))
	}
	fr.data.purgeFail.Store(false)
	if n := s.purgeDormant(ctx); n != 1 || strings.Join(purged(), ",") != dormant+","+dormant || used(dormant) || !used(live) {
		t.Fatalf("purge: %d %v, dormant used %v, live used %v", n, purged(), used(dormant), used(live))
	}
	// Done once: nothing more.
	if n := s.purgeDormant(ctx); n != 0 || len(purged()) != 2 {
		t.Fatalf("purged twice: %d %v", n, purged())
	}

	// The loop itself, on a short interval.
	if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+dormant+"/unarchive", ""); code != http.StatusNoContent {
		t.Fatal("unarchive")
	}
	if code, body := call(t, ts, "alice", "POST", "/api/pages/"+live+"/versions", `{"html":"<p>static</p>"}`); code != http.StatusCreated {
		t.Fatalf("add version: %d %s", code, body)
	}
	s.now = func() time.Time { return time.Now().AddDate(0, 0, 8) }
	s.purgeEvery = 20 * time.Millisecond
	lctx, cancel := context.WithCancel(ctx)
	stopped := make(chan struct{})
	go func() { s.PurgeBackends(lctx); close(stopped) }()
	deadline := time.Now().Add(5 * time.Second)
	for used(live) && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	<-stopped
	if used(live) || purged()[len(purged())-1] != live {
		t.Fatalf("the loop didn't purge: %v", purged())
	}

	// Without the setting, or without backends, the loop doesn't run.
	s.cfg.BackendPurgeAfterDays = 0
	done := make(chan struct{})
	go func() { s.PurgeBackends(ctx); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("the loop runs without a purge setting")
	}
}

// A call or an import refused before the runner is asked leaves its body
// unread: the answer must still come, and the connection stay usable.
func TestBackendRefusalsWithBodies(t *testing.T) {
	fr := newFakeRunner(t)
	ts, _, _ := newBackendTestServer(t, fr)
	page := publishBackendPage(t, ts)
	big := strings.Repeat("x", 200_000)
	for range 3 {
		wantBackendError(t, callBackend(t, ts, context.Background(), "mallory", "POST", "/api/pages/"+page+"/x/a", 1, strings.NewReader(big), nil),
			http.StatusNotFound, "not-found")
		wantBackendError(t, dataReq(t, ts, "mallory", "PUT", "/api/pages/"+page+"/backend/import", strings.NewReader(big), zipType),
			http.StatusNotFound, "not-found")
		wantBackendError(t, dataReq(t, ts, "alice", "PUT", "/api/pages/"+page+"/backend/import", strings.NewReader(big), nil),
			http.StatusBadRequest, "bad-import")
	}
}
