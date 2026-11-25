package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"
)

// asShell sends a request as the public shell would: same origin, with the
// visitor's secret when given.
func asShell(t *testing.T, ts *httptest.Server, method, path, body, secret string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if secret != "" {
		req.Header.Set(visitorHeader, secret)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { res.Body.Close() })
	return res
}

// newVisitor asks the link for a visitor, as the shell does, and returns
// its secret.
func newVisitor(t *testing.T, ts *httptest.Server, token string) string {
	t.Helper()
	res := asShell(t, ts, "POST", "/p/"+token+"/visitor", "", "")
	var v struct{ Secret string }
	mustJSON(t, readBody(t, res), &v)
	if res.StatusCode != http.StatusCreated || v.Secret == "" || len(res.Cookies()) != 0 {
		t.Fatalf("new visitor: %d %+v", res.StatusCode, v)
	}
	return v.Secret
}

func TestVisitorData(t *testing.T) {
	pool := testdb.New(t)
	cfg := &config.Config{AppBaseURL: "http://test", TrustedUserHeader: userHeader, PublicVisitorsPerLink: 2}
	s := New(cfg, store.New(pool), nil, nil)
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)
	ctx := context.Background()

	id := publishPage(t, ts, "alice", "Notes", "<p>notes</p>")
	token := publicLink(t, ts, id, "")
	data := "/p/" + token + "/data"

	// Without a visitor: nothing to read, nothing to write.
	res := asShell(t, ts, "GET", data, "", "")
	if b := trimmed(t, res); res.StatusCode != http.StatusOK || b != "{}" || res.Header.Get("X-Specola-Visitor") != "none" {
		t.Fatalf("no visitor: %d %q %v", res.StatusCode, b, res.Header)
	}
	wantBackendError(t, asShell(t, ts, "PATCH", data, `{"set":{"a":"1"}}`, ""), http.StatusForbidden, "no-visitor")
	wantBackendError(t, asShell(t, ts, "PATCH", data, `{"set":{"a":"1"}}`, "bm90LWEtc2VjcmV0"), http.StatusForbidden, "no-visitor")

	v1 := newVisitor(t, ts, token)
	asShell(t, ts, "PATCH", data, `{"set":{"a":"1","b":"2"}}`, v1)
	asShell(t, ts, "PATCH", data, `{"remove":["b"],"set":{"c":"3"}}`, v1)
	res = asShell(t, ts, "GET", data, "", v1)
	if b := trimmed(t, res); b != `{"a":"1","c":"3"}` || res.Header.Get("X-Specola-Visitor") != "yes" {
		t.Fatalf("read back: %q", b)
	}

	// Another visitor has its own; the owner's own data is apart.
	v2 := newVisitor(t, ts, token)
	asShell(t, ts, "PATCH", data, `{"set":{"x":"other"}}`, v2)
	if b := trimmed(t, asShell(t, ts, "GET", data, "", v2)); b != `{"x":"other"}` {
		t.Fatalf("second visitor: %q", b)
	}
	if code, b := call(t, ts, "alice", "GET", "/api/pages/"+id+"/data", ""); code != http.StatusOK || strings.TrimSpace(b) != "{}" {
		t.Fatalf("the owner's data: %d %q", code, b)
	}

	// Past the cap (2): no third visitor, the storage stays in memory.
	wantBackendError(t, asShell(t, ts, "POST", "/p/"+token+"/visitor", "", ""), http.StatusTooManyRequests, "visitor-limit")

	// Only the shell makes visitors and uses them: not a page (Origin null),
	// nor another site, nor a script that doesn't say it is on this origin.
	for _, h := range []map[string]string{{"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Origin": "http://evil.example"}} {
		for _, r := range []struct{ method, path string }{{"PATCH", data}, {"GET", data}, {"POST", "/p/" + token + "/visitor"}} {
			req, _ := http.NewRequest(r.method, ts.URL+r.path, strings.NewReader(`{"set":{"z":"1"}}`))
			for k, v := range h {
				req.Header.Set(k, v)
			}
			req.Header.Set(visitorHeader, v1)
			wantBackendError(t, mustDo(t, req), http.StatusForbidden, "not-shell")
		}
	}
	if code, _ := call(t, ts, "", "POST", "/p/"+token+"/visitor", ""); code != http.StatusForbidden {
		t.Fatalf("a script makes no visitor: %d", code)
	}
	if b := trimmed(t, asShell(t, ts, "GET", data, "", v1)); b != `{"a":"1","c":"3"}` {
		t.Fatalf("after refused writes: %q", b)
	}

	// The same limits as anyone's.
	res = asShell(t, ts, "PATCH", data, `{"set":{"big":"`+strings.Repeat("x", store.MaxPageDataBytes)+`"}}`, v1)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("over the quota: %d", res.StatusCode)
	}

	// The owner sees how many visitors keep data, not the data.
	_, body := call(t, ts, "alice", "GET", "/api/pages/"+id+"/links", "")
	var links []struct {
		ID           string
		Visitors     int
		VisitorBytes int
	}
	mustJSON(t, body, &links)
	if len(links) != 1 || links[0].Visitors != 2 || links[0].VisitorBytes != len("a1c3xother") {
		t.Fatalf("links: %+v", links)
	}

	// DELETE clears.
	if res := asShell(t, ts, "DELETE", data, "", v1); res.StatusCode != http.StatusNoContent {
		t.Fatalf("clear: %d", res.StatusCode)
	}
	if b := trimmed(t, asShell(t, ts, "GET", data, "", v1)); b != "{}" {
		t.Fatalf("cleared: %q", b)
	}

	// Revoked: the visitors and their data go, and the cleanup of what the
	// runner may keep is queued; with no backend data, the sweep clears it.
	call(t, ts, "alice", "DELETE", "/api/pages/"+id+"/links/"+links[0].ID, "")
	wantBackendError(t, asShell(t, ts, "GET", data, "", v2), http.StatusNotFound, "not-found")
	var n int
	if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM public_visitor) + (SELECT count(*) FROM page_data WHERE link_id IS NOT NULL)`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("left after revoking: %d %v", n, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM visitor_cleanup`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("cleanups queued: %d %v", n, err)
	}
	s.sweepVisitors(ctx)
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM visitor_cleanup`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("cleanups left: %d %v", n, err)
	}
}

func TestIdleVisitorsAreForgotten(t *testing.T) {
	pool := testdb.New(t)
	s := New(&config.Config{AppBaseURL: "http://test", TrustedUserHeader: userHeader}, store.New(pool), nil, nil)
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)
	ctx := context.Background()

	id := publishPage(t, ts, "alice", "Notes", "<p>notes</p>")
	token := publicLink(t, ts, id, "")
	v := newVisitor(t, ts, token)
	asShell(t, ts, "PATCH", "/p/"+token+"/data", `{"set":{"a":"1"}}`, v)
	if _, err := pool.Exec(ctx, `UPDATE public_visitor SET last_seen_at = now() - interval '91 days'`); err != nil {
		t.Fatal(err)
	}
	s.sweepVisitors(ctx)
	// Forgotten: its secret names no one.
	res := asShell(t, ts, "GET", "/p/"+token+"/data", "", v)
	if b := trimmed(t, res); b != "{}" || res.Header.Get("X-Specola-Visitor") != "none" {
		t.Fatalf("after the sweep: %q", b)
	}
	// Seen recently: kept.
	v = newVisitor(t, ts, token)
	asShell(t, ts, "PATCH", "/p/"+token+"/data", `{"set":{"a":"2"}}`, v)
	s.sweepVisitors(ctx)
	if b := trimmed(t, asShell(t, ts, "GET", "/p/"+token+"/data", "", v)); b != `{"a":"2"}` {
		t.Fatalf("a recent visitor: %q", b)
	}
}

func TestPublicCallsCarryTheVisitor(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, pool := newBackendTestServer(t, fr)
	ctx := context.Background()
	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Votes"}`), publicBundle, "")
	token := publicLink(t, ts, page, "")

	secret := newVisitor(t, ts, token)
	h := http.Header{visitorHeader: {secret}}
	for i := 0; i < 2; i++ {
		if res := publicCall(t, ts, "GET", "/p/"+token+"/x/api/stats", 1, nil, h); res.StatusCode != http.StatusCreated {
			t.Fatalf("call: %d", res.StatusCode)
		}
	}
	// Without one, as before.
	publicCall(t, ts, "GET", "/p/"+token+"/x/api/stats", 1, nil, nil)

	fr.mu.Lock()
	calls := append([]runnerCall(nil), fr.calls...)
	fr.mu.Unlock()
	if len(calls) < 3 {
		t.Fatalf("calls: %d", len(calls))
	}
	a, b, none := calls[len(calls)-3].head, calls[len(calls)-2].head, calls[len(calls)-1].head
	hash, _ := visitorHash(secret)
	if a.Visitor == nil || a.Visitor.ID != hash || b.Visitor == nil || b.Visitor.ID != hash || none.Visitor != nil ||
		a.User != nil || a.Role != "public" {
		t.Fatalf("heads: %+v / %+v / %+v", a.Visitor, b.Visitor, none.Visitor)
	}
	// The secret itself never reaches the backend.
	for _, h := range a.Request.Headers {
		if strings.Contains(h[1], secret) {
			t.Fatalf("the secret reached the runner in %s", h[0])
		}
	}

	// Revoked: the runner is asked to delete the visitor's database, which
	// it holds once the page's backend has run.
	if _, err := pool.Exec(ctx, `UPDATE asset SET backend_used_at = now() WHERE id = $1::uuid`, page); err != nil {
		t.Fatal(err)
	}
	var linkID string
	pool.QueryRow(ctx, `SELECT id::text FROM public_link WHERE asset_id = $1::uuid`, page).Scan(&linkID)
	call(t, ts, "alice", "DELETE", "/api/pages/"+page+"/links/"+linkID, "")
	s.sweepVisitors(ctx)
	if got := fr.data.deletedMyData(); len(got) != 1 || got[0] != page+" anon:"+hash {
		t.Fatalf("runner deletions: %v", got)
	}
	var n int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM visitor_cleanup`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("cleanups left: %d %v", n, err)
	}
}

// deletedMyData lists the runner's DELETE my-data calls, as "page sub".
func (d *fakeData) deletedMyData() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []string
	for _, c := range d.calls {
		if c.method == "DELETE" && strings.HasSuffix(c.path, "/my-data") {
			page := strings.TrimSuffix(strings.TrimPrefix(c.path, "/pages/"), "/my-data")
			out = append(out, page+" "+c.sub)
		}
	}
	return out
}

func trimmed(t *testing.T, res *http.Response) string {
	t.Helper()
	return strings.TrimSpace(readBody(t, res))
}
