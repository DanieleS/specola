package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"
)

func TestPublicLinks(t *testing.T) {
	ts := newTestServer(t)
	const alice, bob = "alice@example.com", "bob@example.com"
	call(t, ts, bob, "GET", "/api/me", "")

	expect := func(user, method, path, body string, want int) string {
		t.Helper()
		code, got := call(t, ts, user, method, path, body)
		if code != want {
			t.Fatalf("%s %s %s: %d %s, want %d", user, method, path, code, got, want)
		}
		return got
	}
	code, body := call(t, ts, alice, "POST", "/api/pages", `{"name":"Report","html":"<p>v1</p>"}`)
	id := createdID(t, code, body)
	expect(alice, "POST", "/api/pages/"+id+"/versions", `{"html":"<p>v2</p>"}`, http.StatusCreated)
	links := "/api/pages/" + id + "/links"

	create := func(body string) (linkID, path string) {
		t.Helper()
		var l struct{ ID, URL string }
		mustJSON(t, expect(alice, "POST", links, body, http.StatusCreated), &l)
		u, err := url.Parse(l.URL)
		if err != nil || u.Scheme+"://"+u.Host != "http://test" || !strings.HasPrefix(u.Path, "/s/") {
			t.Fatalf("url = %q", l.URL)
		}
		return l.ID, u.Path
	}
	// open fetches a public link with no user, as anyone would.
	open := func(path string) (int, string, http.Header) {
		t.Helper()
		res := get(t, ts, "", path, nil)
		return res.StatusCode, readBody(t, res), res.Header
	}

	current, currentPath := create(`{"label":"for the board"}`)
	_, pinnedPath := create(`{"version":1,"expiresInDays":7}`)

	t.Run("anyone with the link sees the page, sandboxed", func(t *testing.T) {
		code, body, h := open(currentPath)
		if code != http.StatusOK || body != withSDK("<p>v2</p>") {
			t.Fatalf("open: %d %q", code, body)
		}
		csp := h.Get("Content-Security-Policy")
		if !strings.Contains(csp, "sandbox allow-scripts") || !strings.Contains(csp, "frame-ancestors 'none'") {
			t.Fatalf("CSP = %q", csp)
		}
		for k, want := range map[string]string{"Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow"} {
			if h.Get(k) != want {
				t.Fatalf("%s = %q, want %q", k, h.Get(k), want)
			}
		}
		if _, body, _ := open(pinnedPath); body != withSDK("<p>v1</p>") {
			t.Fatalf("pinned: %q", body)
		}
		expect(alice, "POST", "/api/pages/"+id+"/versions", `{"html":"<p>v3</p>"}`, http.StatusCreated)
		if _, body, _ := open(currentPath); body != withSDK("<p>v3</p>") {
			t.Fatalf("after a new version: %q", body)
		}
		if _, body, _ := open(pinnedPath); body != withSDK("<p>v1</p>") {
			t.Fatalf("pinned after a new version: %q", body)
		}
		for _, p := range []string{"/s/nope", "/s/" + strings.Repeat("A", 43)} {
			if code, _, _ := open(p); code != http.StatusNotFound {
				t.Fatalf("%s: %d, want 404", p, code)
			}
		}
	})

	t.Run("owner lists them; the page says it is public", func(t *testing.T) {
		var ls []struct {
			ID, Label string
			Version   *int
			ExpiresAt *string
			Views     int
		}
		mustJSON(t, expect(alice, "GET", links, "", http.StatusOK), &ls)
		if len(ls) != 2 || ls[1].ID != current || ls[1].Label != "for the board" || ls[1].Version != nil || ls[1].ExpiresAt != nil || ls[1].Views != 2 {
			t.Fatalf("links = %+v", ls)
		}
		if ls[0].Version == nil || *ls[0].Version != 1 || ls[0].ExpiresAt == nil {
			t.Fatalf("pinned link = %+v", ls[0])
		}
		var meta struct{ Public bool }
		mustJSON(t, expect(alice, "GET", "/api/pages/"+id, "", http.StatusOK), &meta)
		if !meta.Public {
			t.Fatal("page meta doesn't say the page is public")
		}
	})

	t.Run("only the owner manages them", func(t *testing.T) {
		expect(bob, "GET", links, "", http.StatusNotFound)
		expect(bob, "POST", links, `{}`, http.StatusNotFound)
		expect(alice, "PUT", "/api/pages/"+id+"/acl", `{"email":"`+bob+`","role":"editor"}`, http.StatusNoContent)
		expect(bob, "GET", links, "", http.StatusForbidden)
		expect(bob, "POST", links, `{}`, http.StatusForbidden)
		expect(bob, "DELETE", links+"/"+current, "", http.StatusForbidden)
		var meta struct{ Public bool }
		mustJSON(t, expect(bob, "GET", "/api/pages/"+id, "", http.StatusOK), &meta)
		if meta.Public {
			t.Fatal("an editor is told the page has public links")
		}
	})

	t.Run("bad requests", func(t *testing.T) {
		expect(alice, "POST", links, `{"version":9}`, http.StatusBadRequest)
		expect(alice, "POST", links, `{"expiresInDays":400}`, http.StatusBadRequest)
		expect(alice, "POST", links, `{"expiresInDays":-1}`, http.StatusBadRequest)
		expect(alice, "POST", links, `{"label":"`+strings.Repeat("x", 101)+`"}`, http.StatusBadRequest)
	})

	t.Run("archiving takes them down until restored", func(t *testing.T) {
		expect(alice, "POST", "/api/pages/"+id+"/archive", "", http.StatusNoContent)
		if code, _, _ := open(currentPath); code != http.StatusNotFound {
			t.Fatalf("archived: %d, want 404", code)
		}
		expect(alice, "POST", "/api/pages/"+id+"/unarchive", "", http.StatusNoContent)
		if code, _, _ := open(currentPath); code != http.StatusOK {
			t.Fatalf("unarchived: %d, want 200", code)
		}
	})

	t.Run("revoking stops the link at once", func(t *testing.T) {
		expect(alice, "DELETE", links+"/"+current, "", http.StatusNoContent)
		if code, _, _ := open(currentPath); code != http.StatusNotFound {
			t.Fatalf("revoked: %d, want 404", code)
		}
		expect(alice, "DELETE", links+"/"+current, "", http.StatusNoContent)
		expect(alice, "DELETE", links+"/not-a-uuid", "", http.StatusNoContent)
		if code, _, _ := open(pinnedPath); code != http.StatusOK {
			t.Fatalf("the other link: %d, want 200", code)
		}
	})
}

func TestPublicLinksOnViewOrigin(t *testing.T) {
	cfg := &config.Config{
		AppBaseURL:        "https://specola.test",
		TrustedUserHeader: userHeader,
		ViewOrigin:        viewOrigin,
		SessionSecret:     "test-secret-test-secret-test-secret",
	}
	ts := httptest.NewServer(New(cfg, store.New(testdb.New(t)), nil, nil))
	t.Cleanup(ts.Close)

	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"P","html":"<p>hi</p>"}`)
	id := createdID(t, code, body)
	code, body = call(t, ts, "alice", "POST", "/api/pages/"+id+"/links", `{}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	var l struct{ URL string }
	mustJSON(t, body, &l)
	u, err := url.Parse(l.URL)
	if err != nil || u.Scheme+"://"+u.Host != viewOrigin {
		t.Fatalf("url = %q, want it on the view origin", l.URL)
	}

	res := get(t, ts, "view.specola.test", u.Path, nil)
	if b := readBody(t, res); res.StatusCode != http.StatusOK || b != withSDK("<p>hi</p>") {
		t.Fatalf("view origin: %d %q", res.StatusCode, b)
	}
	if acao := res.Header.Get("Access-Control-Allow-Origin"); acao != "" {
		t.Fatalf("public link allows CORS from %q", acao)
	}
	if res := get(t, ts, "", u.Path, nil); res.StatusCode != http.StatusNotFound || strings.Contains(readBody(t, res), "<p>hi</p>") {
		t.Fatalf("app origin: %d, want 404", res.StatusCode)
	}
}
