package server

import (
	"net/http"
	"strings"
	"testing"
)

func TestVersionHistory(t *testing.T) {
	ts := newTestServer(t)
	const alice, bob = "alice@example.com", "bob@example.com"
	call(t, ts, bob, "GET", "/api/me", "")

	code, body := call(t, ts, alice, "POST", "/api/pages", `{"name":"Doc","html":"<p>one</p>"}`)
	id := createdID(t, code, body)
	call(t, ts, alice, "POST", "/api/pages/"+id+"/versions", `{"html":"<p>two</p>"}`)

	code, body = call(t, ts, alice, "GET", "/api/pages/"+id+"/versions", "")
	var vs []struct {
		Version      int
		EditedBy     string
		RestoredFrom *int
	}
	mustJSON(t, body, &vs)
	if code != http.StatusOK || len(vs) != 2 || vs[0].Version != 2 || vs[0].EditedBy != alice {
		t.Fatalf("versions: %d %s", code, body)
	}

	if _, got := call(t, ts, alice, "GET", "/view/"+id+"?v=1", ""); got != withSDK("<p>one</p>") {
		t.Fatalf("view v1 = %q", got)
	}
	for _, v := range []string{"0", "x", "9"} {
		if code, _ := call(t, ts, alice, "GET", "/view/"+id+"?v="+v, ""); code == http.StatusOK {
			t.Fatalf("view v=%s: 200", v)
		}
	}

	code, body = call(t, ts, alice, "POST", "/api/pages/"+id+"/versions", `{"restoreFrom":1}`)
	if code != http.StatusCreated || !strings.Contains(body, `"version":3`) {
		t.Fatalf("restore: %d %s", code, body)
	}
	if _, got := call(t, ts, alice, "GET", "/view/"+id, ""); got != withSDK("<p>one</p>") {
		t.Fatalf("after restore = %q", got)
	}
	_, body = call(t, ts, alice, "GET", "/api/pages/"+id+"/versions", "")
	mustJSON(t, body, &vs)
	if len(vs) != 3 || vs[0].RestoredFrom == nil || *vs[0].RestoredFrom != 1 {
		t.Fatalf("history after restore: %s", body)
	}

	if code, _ := call(t, ts, alice, "POST", "/api/pages/"+id+"/versions", `{"html":"x","restoreFrom":1}`); code != http.StatusBadRequest {
		t.Fatalf("html and restoreFrom: %d, want 400", code)
	}
	if code, _ := call(t, ts, alice, "POST", "/api/pages/"+id+"/versions", `{"restoreFrom":42}`); code != http.StatusNotFound {
		t.Fatalf("restore missing version: %d, want 404", code)
	}

	// A viewer sees the history but can't restore; others see nothing.
	if code, _ := call(t, ts, "stranger@example.com", "GET", "/api/pages/"+id+"/versions", ""); code != http.StatusNotFound {
		t.Fatalf("stranger versions: %d, want 404", code)
	}
	call(t, ts, alice, "PUT", "/api/pages/"+id+"/acl", `{"email":"`+bob+`","role":"viewer"}`)
	if code, _ := call(t, ts, bob, "GET", "/view/"+id+"?v=2", ""); code != http.StatusOK {
		t.Fatalf("viewer old version: %d", code)
	}
	if code, _ := call(t, ts, bob, "POST", "/api/pages/"+id+"/versions", `{"restoreFrom":2}`); code != http.StatusForbidden {
		t.Fatalf("viewer restore: %d, want 403", code)
	}
}

func TestRenameMoveArchive(t *testing.T) {
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
	create := func(user, path, body string) string {
		t.Helper()
		code, got := call(t, ts, user, "POST", path, body)
		return createdID(t, code, got)
	}
	slug := func(id string) string {
		t.Helper()
		var m struct{ Slug string }
		mustJSON(t, expect(alice, "GET", "/api/pages/"+id, "", http.StatusOK), &m)
		return m.Slug
	}

	a := create(alice, "/api/folders", `{"name":"A"}`)
	b := create(alice, "/api/folders", `{"name":"B","parentId":"`+a+`"}`)
	p := create(alice, "/api/pages", `{"name":"Report","html":"<p>quarterly numbers</p>"}`)
	create(alice, "/api/pages", `{"name":"Summary","html":"<p>x</p>"}`)

	t.Run("rename", func(t *testing.T) {
		expect(alice, "PATCH", "/api/pages/"+p, `{"name":"Final report"}`, http.StatusNoContent)
		if s := slug(p); s != "final-report" {
			t.Fatalf("slug = %q", s)
		}
		expect(alice, "PATCH", "/api/pages/"+p, `{"name":"Summary"}`, http.StatusNoContent)
		if s := slug(p); s != "summary-2" {
			t.Fatalf("colliding slug = %q", s)
		}
		expect(alice, "PATCH", "/api/pages/"+p, `{"name":"  "}`, http.StatusBadRequest)
		// Search follows the new name.
		if res := expect(alice, "GET", "/api/search?q=summary", "", http.StatusOK); !strings.Contains(res, p) {
			t.Fatalf("search by new name: %s", res)
		}
	})

	t.Run("move", func(t *testing.T) {
		expect(alice, "PATCH", "/api/pages/"+p, `{"parentId":"`+b+`"}`, http.StatusNoContent)
		if tree := expect(alice, "GET", "/api/tree?parent="+b, "", http.StatusOK); !strings.Contains(tree, p) {
			t.Fatalf("page not in B: %s", tree)
		}
		expect(alice, "PATCH", "/api/folders/"+a, `{"parentId":"`+b+`"}`, http.StatusBadRequest)
		expect(alice, "PATCH", "/api/folders/"+a, `{"parentId":"`+a+`"}`, http.StatusBadRequest)
		expect(alice, "PATCH", "/api/folders/"+a, `{"parentId":42}`, http.StatusBadRequest)

		// An editor can move within folders they can edit, not to the root
		// or into a folder they can only view.
		expect(alice, "PUT", "/api/folders/"+a+"/acl", `{"email":"`+bob+`","role":"editor"}`, http.StatusNoContent)
		expect(bob, "PATCH", "/api/pages/"+p, `{"parentId":"`+a+`"}`, http.StatusNoContent)
		expect(bob, "PATCH", "/api/pages/"+p, `{"parentId":null}`, http.StatusForbidden)
		expect(alice, "PUT", "/api/folders/"+b+"/acl", `{"email":"`+bob+`","role":"viewer"}`, http.StatusNoContent)
		expect(bob, "PATCH", "/api/pages/"+p, `{"parentId":"`+b+`"}`, http.StatusForbidden)
		expect(alice, "PATCH", "/api/pages/"+p, `{"parentId":null}`, http.StatusNoContent)
		if tree := expect(alice, "GET", "/api/tree", "", http.StatusOK); !strings.Contains(tree, p) {
			t.Fatalf("page not at root: %s", tree)
		}
		expect(alice, "PATCH", "/api/pages/"+p, `{"parentId":"`+a+`"}`, http.StatusNoContent)
	})

	t.Run("archive hides everything beneath", func(t *testing.T) {
		expect(bob, "POST", "/api/folders/"+a+"/archive", "", http.StatusForbidden)
		expect(alice, "POST", "/api/folders/"+a+"/archive", "", http.StatusNoContent)

		expect(alice, "GET", "/view/"+p, "", http.StatusNotFound)
		expect(alice, "GET", "/api/tree?parent="+a, "", http.StatusNotFound)
		if res := expect(alice, "GET", "/api/search?q=quarterly", "", http.StatusOK); strings.Contains(res, p) {
			t.Fatalf("archived page in search: %s", res)
		}
		if tree := expect(alice, "GET", "/api/tree", "", http.StatusOK); strings.Contains(tree, a) {
			t.Fatalf("archived folder at root: %s", tree)
		}
		expect(bob, "GET", "/view/"+p, "", http.StatusNotFound)

		archived := expect(alice, "GET", "/api/archived", "", http.StatusOK)
		if !strings.Contains(archived, a) || strings.Contains(archived, p) {
			t.Fatalf("archived list should hold the folder only: %s", archived)
		}
		if got := expect(bob, "GET", "/api/archived", "", http.StatusOK); strings.TrimSpace(got) != "[]" {
			t.Fatalf("bob's archived list: %s", got)
		}

		expect(bob, "POST", "/api/folders/"+a+"/unarchive", "", http.StatusForbidden)
		expect(alice, "POST", "/api/folders/"+a+"/unarchive", "", http.StatusNoContent)
		expect(alice, "GET", "/view/"+p, "", http.StatusOK)
		expect(bob, "GET", "/view/"+p, "", http.StatusOK)
	})

	t.Run("unarchive takes a free slug", func(t *testing.T) {
		old := create(alice, "/api/pages", `{"name":"Draft","html":"x"}`)
		expect(alice, "POST", "/api/pages/"+old+"/archive", "", http.StatusNoContent)
		create(alice, "/api/pages", `{"name":"Draft","html":"y"}`)
		expect(alice, "POST", "/api/pages/"+old+"/unarchive", "", http.StatusNoContent)
		if s := slug(old); s != "draft-2" {
			t.Fatalf("slug after unarchive = %q", s)
		}
	})
}
