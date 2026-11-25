package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// secretsBundle is an app whose backend declares two secrets.
var secretsBundle = files{
	"index.html":                `<p>app</p>`,
	".specola/backend.json":     `{"version":1,"secrets":["API_KEY","OTHER_KEY"],"egress":["api.example.com"]}`,
	".specola/server/index.mjs": `export default { fetch: () => new Response("hi") }`,
}

// secretsList is GET /api/pages/{id}/secrets as user.
type secretsList struct {
	Secrets []struct {
		Name          string
		Declared, Set bool
		UpdatedAt     *string
		UpdatedBy     string
	}
}

func TestSecretsRoutes(t *testing.T) {
	fr := newFakeRunner(t)
	ts, _, _ := newBackendTestServer(t, fr)
	ctx := context.Background()
	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Shop"}`), secretsBundle, "")
	for user, role := range map[string]string{"ed": "editor", "viewer": "viewer"} {
		if code, body := call(t, ts, "alice", "PUT", "/api/pages/"+page+"/acl", `{"sub":"`+user+`","role":"`+role+`"}`); code != http.StatusNoContent {
			t.Fatalf("share: %d %s", code, body)
		}
	}
	base := "/api/pages/" + page + "/secrets"
	req := func(user, method, path, body string) *http.Response {
		t.Helper()
		r, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set(userHeader, user)
		return mustDo(t, r)
	}
	list := func(user string) secretsList {
		t.Helper()
		code, body := call(t, ts, user, "GET", base, "")
		if code != http.StatusOK {
			t.Fatalf("list as %s: %d %s", user, code, body)
		}
		if strings.Contains(body, "sk-") {
			t.Fatalf("a value was listed: %s", body)
		}
		var l secretsList
		mustJSON(t, body, &l)
		return l
	}
	missing := func(user string) (string, bool) {
		t.Helper()
		code, body := call(t, ts, user, "GET", "/api/pages/"+page, "")
		if code != http.StatusOK {
			t.Fatalf("meta: %d %s", code, body)
		}
		var m struct{ BackendSecretsMissing *[]string }
		mustJSON(t, body, &m)
		if m.BackendSecretsMissing == nil {
			return "", false
		}
		return strings.Join(*m.BackendSecretsMissing, ","), true
	}

	l := list("alice")
	if len(l.Secrets) != 2 || l.Secrets[0].Name != "API_KEY" || !l.Secrets[0].Declared || l.Secrets[0].Set ||
		l.Secrets[0].UpdatedAt != nil || l.Secrets[1].Name != "OTHER_KEY" {
		t.Fatalf("list = %+v", l)
	}
	if m, ok := missing("alice"); !ok || m != "API_KEY,OTHER_KEY" {
		t.Fatalf("owner's missing = %q %v", m, ok)
	}
	if m, ok := missing("ed"); !ok || m != "API_KEY,OTHER_KEY" {
		t.Fatalf("editor's missing = %q %v", m, ok)
	}
	if _, ok := missing("viewer"); ok {
		t.Fatal("a viewer is told which secrets are missing")
	}

	// Roles.
	wantBackendError(t, req("ed", "PUT", base+"/API_KEY", `{"value":"sk-1"}`), http.StatusForbidden, "forbidden")
	wantBackendError(t, req("ed", "DELETE", base+"/API_KEY", ""), http.StatusForbidden, "forbidden")
	wantBackendError(t, req("viewer", "GET", base, ""), http.StatusForbidden, "forbidden")
	wantBackendError(t, req("mallory", "GET", base, ""), http.StatusNotFound, "not-found")
	wantBackendError(t, req("mallory", "PUT", base+"/API_KEY", `{"value":"sk-1"}`), http.StatusNotFound, "not-found")
	list("ed")

	// Bad names and values.
	for _, bad := range [][2]string{
		{"api_key", `{"value":"sk-1"}`}, {"1KEY", `{"value":"sk-1"}`},
		{"API_KEY", `{"value":""}`}, {"API_KEY", `{}`}, {"API_KEY", `{"value":5}`}, {"API_KEY", `nope`},
		{"API_KEY", `{"value":"` + strings.Repeat("x", 8193) + `"}`}, {"API_KEY", `{"value":"x","other":1}`},
	} {
		wantBackendError(t, req("alice", "PUT", base+"/"+bad[0], bad[1]), http.StatusBadRequest, "bad-request")
	}
	wantBackendError(t, req("alice", "DELETE", base+"/bad-name", ""), http.StatusBadRequest, "bad-request")

	// Set: listed as set, never shown; an undeclared one is listed too.
	for name, value := range map[string]string{"API_KEY": "sk-live", "FUTURE_KEY": "sk-later"} {
		if res := req("alice", "PUT", base+"/"+name, `{"value":"`+value+`"}`); res.StatusCode != http.StatusNoContent {
			t.Fatalf("set %s: %d %s", name, res.StatusCode, readBody(t, res))
		}
	}
	l = list("alice")
	if len(l.Secrets) != 3 || l.Secrets[0].Name != "API_KEY" || !l.Secrets[0].Set || l.Secrets[0].UpdatedBy != "alice" ||
		l.Secrets[0].UpdatedAt == nil || l.Secrets[1].Name != "FUTURE_KEY" || l.Secrets[1].Declared || !l.Secrets[1].Set ||
		l.Secrets[2].Set {
		t.Fatalf("list = %+v", l)
	}
	if m, _ := missing("alice"); m != "OTHER_KEY" {
		t.Fatalf("missing = %q", m)
	}

	// A call gets the declared secrets that are set, and only those.
	res := callBackend(t, ts, ctx, "viewer", "GET", "/api/pages/"+page+"/x/s", 1, nil, nil)
	readBody(t, res)
	if c := fr.last(t); len(c.head.Secrets) != 1 || c.head.Secrets["API_KEY"] != "sk-live" || strings.Join(c.head.Egress, ",") != "api.example.com" {
		t.Fatalf("head secrets = %v, egress %v", c.head.Secrets, c.head.Egress)
	}

	// Delete, also when unset.
	for range 2 {
		if res := req("alice", "DELETE", base+"/API_KEY", ""); res.StatusCode != http.StatusNoContent {
			t.Fatalf("delete: %d", res.StatusCode)
		}
	}
	if m, _ := missing("alice"); m != "API_KEY,OTHER_KEY" {
		t.Fatalf("missing after delete = %q", m)
	}

	// A page without a backend: no missing list at all.
	plain := newPlainPage(t, ts, "alice")
	code, body := call(t, ts, "alice", "GET", "/api/pages/"+plain, "")
	if code != http.StatusOK || strings.Contains(body, "backendSecretsMissing") {
		t.Fatalf("plain meta: %d %s", code, body)
	}
}

func TestSecretsWithoutBackends(t *testing.T) {
	ts := newTestServer(t)
	page := newPlainPage(t, ts, "alice")
	r, _ := http.NewRequest("PUT", ts.URL+"/api/pages/"+page+"/secrets/API_KEY", strings.NewReader(`{"value":"v"}`))
	r.Header.Set(userHeader, "alice")
	wantBackendError(t, mustDo(t, r), http.StatusServiceUnavailable, "backend-disabled")
	if code, body := call(t, ts, "alice", "GET", "/api/pages/"+page+"/secrets", ""); code != http.StatusOK || body != `{"secrets":[]}`+"\n" {
		t.Fatalf("list: %d %s", code, body)
	}
}

// newPlainPage creates a page without a backend as user.
func newPlainPage(t *testing.T, ts *httptest.Server, user string) string {
	t.Helper()
	code, body := call(t, ts, user, "POST", "/api/pages", `{"name":"Plain","html":"<p>x</p>"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	var p struct{ ID string }
	mustJSON(t, body, &p)
	return p.ID
}
