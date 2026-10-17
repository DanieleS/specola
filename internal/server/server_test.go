package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"
)

const userHeader = "X-Test-User"

// newTestServer runs Specola in trusted-header mode, so each request picks its
// user through userHeader.
func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	cfg := &config.Config{AppBaseURL: "http://test", TrustedUserHeader: userHeader}
	ts := httptest.NewServer(New(cfg, store.New(testdb.New(t)), nil, nil))
	t.Cleanup(ts.Close)
	return ts
}

// call sends a request as user and returns the status and body.
func call(t *testing.T, ts *httptest.Server, user, method, path, body string) (int, string) {
	t.Helper()
	var rd io.Reader
	if body != "" {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, ts.URL+path, rd)
	if err != nil {
		t.Fatal(err)
	}
	if user != "" {
		req.Header.Set(userHeader, user)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func mustJSON(t *testing.T, s string, dst any) {
	t.Helper()
	if err := json.Unmarshal([]byte(s), dst); err != nil {
		t.Fatalf("decode %q: %v", s, err)
	}
}

func TestMe(t *testing.T) {
	ts := newTestServer(t)

	code, body := call(t, ts, "alice@example.com", "GET", "/api/me", "")
	if code != http.StatusOK {
		t.Fatalf("me: %d %s", code, body)
	}
	var me map[string]string
	mustJSON(t, body, &me)
	if me["sub"] != "alice@example.com" || me["email"] != "alice@example.com" {
		t.Fatalf("me = %v", me)
	}

	if code, _ := call(t, ts, "", "GET", "/api/me", ""); code != http.StatusUnauthorized {
		t.Fatalf("anonymous me: %d, want 401", code)
	}
}

func TestPagesArePrivateToTheirAuthor(t *testing.T) {
	ts := newTestServer(t)
	const alice, bob = "alice", "bob"

	code, body := call(t, ts, alice, "POST", "/api/folders", `{"name":"Reports"}`)
	if code != http.StatusCreated {
		t.Fatalf("create folder: %d %s", code, body)
	}
	var folder struct{ ID string }
	mustJSON(t, body, &folder)

	code, body = call(t, ts, alice, "POST", "/api/pages",
		`{"name":"Q3","html":"<p>secret</p>","folderId":"`+folder.ID+`"}`)
	if code != http.StatusCreated {
		t.Fatalf("create page: %d %s", code, body)
	}
	var page struct{ ID string }
	mustJSON(t, body, &page)

	// The author sees everything.
	for _, path := range []string{"/api/tree", "/api/tree?parent=" + folder.ID, "/api/pages/" + page.ID, "/view/" + page.ID} {
		code, body := call(t, ts, alice, "GET", path, "")
		if code != http.StatusOK {
			t.Fatalf("alice GET %s: %d %s", path, code, body)
		}
		if path == "/api/tree" && !strings.Contains(body, folder.ID) {
			t.Fatalf("alice's root tree misses her folder: %s", body)
		}
	}

	// Someone else sees nothing, and gets 404 rather than 403.
	code, body = call(t, ts, bob, "GET", "/api/tree", "")
	if code != http.StatusOK || strings.TrimSpace(body) != "[]" {
		t.Fatalf("bob root tree: %d %s, want empty", code, body)
	}
	for _, path := range []string{"/api/tree?parent=" + folder.ID, "/api/pages/" + page.ID, "/view/" + page.ID} {
		if code, body := call(t, ts, bob, "GET", path, ""); code != http.StatusNotFound {
			t.Fatalf("bob GET %s: %d %s, want 404", path, code, body)
		}
	}
	writes := []struct{ path, body string }{
		{"/api/pages/" + page.ID + "/versions", `{"html":"<p>pwned</p>"}`},
		{"/api/folders", `{"name":"Inside","parentId":"` + folder.ID + `"}`},
		{"/api/pages", `{"name":"Inside","html":"<p>x</p>","folderId":"` + folder.ID + `"}`},
	}
	for _, w := range writes {
		if code, body := call(t, ts, bob, "POST", w.path, w.body); code != http.StatusNotFound {
			t.Fatalf("bob POST %s: %d %s, want 404", w.path, code, body)
		}
	}

	// Bob's attempt left the page untouched.
	if _, body := call(t, ts, alice, "GET", "/view/"+page.ID, ""); body != withSDK("<p>secret</p>") {
		t.Fatalf("page content changed: %q", body)
	}
}

func TestMalformedIDsAreNotFound(t *testing.T) {
	ts := newTestServer(t)
	for _, path := range []string{"/api/tree?parent=nope", "/api/pages/nope", "/view/nope"} {
		if code, body := call(t, ts, "alice", "GET", path, ""); code != http.StatusNotFound {
			t.Fatalf("GET %s: %d %s, want 404", path, code, body)
		}
	}
	if code, body := call(t, ts, "alice", "POST", "/api/pages/nope/versions", `{"html":"x"}`); code != http.StatusNotFound {
		t.Fatalf("add version: %d %s, want 404", code, body)
	}
}

func TestDuplicatePageNamesGetDistinctSlugs(t *testing.T) {
	ts := newTestServer(t)
	for i, want := range []string{"hello", "hello-2"} {
		code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"Hello","html":"<p>x</p>"}`)
		if code != http.StatusCreated {
			t.Fatalf("create #%d: %d %s", i+1, code, body)
		}
		var p struct{ ID string }
		mustJSON(t, body, &p)
		_, body = call(t, ts, "alice", "GET", "/api/pages/"+p.ID, "")
		var meta struct{ Slug string }
		mustJSON(t, body, &meta)
		if meta.Slug != want {
			t.Fatalf("create #%d slug = %q, want %q", i+1, meta.Slug, want)
		}
	}
}
