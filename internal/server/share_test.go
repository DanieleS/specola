package server

import (
	"net/http"
	"strings"
	"testing"
)

// createdID checks a create response and returns the new item's id.
func createdID(t *testing.T, code int, body string) string {
	t.Helper()
	if code != http.StatusCreated {
		t.Fatalf("create: %d %s", code, body)
	}
	var v struct{ ID string }
	mustJSON(t, body, &v)
	return v.ID
}

func TestSharing(t *testing.T) {
	ts := newTestServer(t)
	const alice, bob, carol = "alice@example.com", "bob@example.com", "carol@example.com"

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
	roleIn := func(listing, id string) string {
		t.Helper()
		var items []struct{ ID, Role string }
		mustJSON(t, listing, &items)
		for _, it := range items {
			if it.ID == id {
				return it.Role
			}
		}
		return ""
	}

	// Bob signs in once so his email resolves to a sub.
	expect(bob, "GET", "/api/me", "", http.StatusOK)

	folder := create(alice, "/api/folders", `{"name":"Team"}`)
	page := create(alice, "/api/pages", `{"name":"Plan","html":"<p>v1</p>","folderId":"`+folder+`"}`)
	private := create(alice, "/api/pages", `{"name":"Diary","html":"<p>mine</p>"}`)
	fAPI := "/api/folders/" + folder + "/acl"

	t.Run("share rules", func(t *testing.T) {
		expect(alice, "PUT", fAPI, `{"email":"nobody@example.com","role":"viewer"}`, http.StatusBadRequest)
		expect(alice, "PUT", fAPI, `{"email":"`+alice+`","role":"viewer"}`, http.StatusBadRequest)
		expect(alice, "PUT", fAPI, `{"email":"`+bob+`","role":"admin"}`, http.StatusBadRequest)
		expect(bob, "PUT", fAPI, `{"email":"`+bob+`","role":"editor"}`, http.StatusNotFound)
	})

	t.Run("viewer reads but can't write", func(t *testing.T) {
		expect(alice, "PUT", fAPI, `{"email":"BOB@example.com","role":"viewer"}`, http.StatusNoContent)

		shared := expect(bob, "GET", "/api/shared", "", http.StatusOK)
		if roleIn(shared, folder) != "viewer" {
			t.Fatalf("bob's shared list: %s", shared)
		}
		if tree := expect(bob, "GET", "/api/tree?parent="+folder, "", http.StatusOK); roleIn(tree, page) != "viewer" {
			t.Fatalf("bob's view of the folder: %s", tree)
		}
		expect(bob, "GET", "/view/"+page, "", http.StatusOK)
		expect(bob, "POST", "/api/pages/"+page+"/versions", `{"html":"<p>bob</p>"}`, http.StatusForbidden)
		expect(bob, "POST", "/api/pages", `{"name":"x","html":"x","folderId":"`+folder+`"}`, http.StatusForbidden)
		expect(bob, "GET", fAPI, "", http.StatusForbidden)
		expect(bob, "PUT", fAPI, `{"email":"`+bob+`","role":"editor"}`, http.StatusForbidden)
		// Only what's shared: Alice's root page stays hidden.
		expect(bob, "GET", "/view/"+private, "", http.StatusNotFound)
	})

	var bobsPage string
	t.Run("editor writes, owner keeps control", func(t *testing.T) {
		expect(alice, "PUT", fAPI, `{"email":"`+bob+`","role":"editor"}`, http.StatusNoContent)
		expect(bob, "POST", "/api/pages/"+page+"/versions", `{"html":"<p>v2</p>"}`, http.StatusCreated)
		bobsPage = create(bob, "/api/pages", `{"name":"Notes","html":"<p>bob</p>","folderId":"`+folder+`"}`)

		// Alice owns everything under her folder, including what Bob added.
		if tree := expect(alice, "GET", "/api/tree?parent="+folder, "", http.StatusOK); roleIn(tree, bobsPage) != "owner" {
			t.Fatalf("alice's view of bob's page: %s", tree)
		}
		if got := expect(alice, "GET", "/view/"+bobsPage, "", http.StatusOK); got != withSDK("<p>bob</p>") {
			t.Fatalf("alice /view of bob's page = %q", got)
		}

		shares := expect(alice, "GET", fAPI, "", http.StatusOK)
		if !strings.Contains(shares, `"sub":"`+bob+`"`) || !strings.Contains(shares, `"role":"editor"`) {
			t.Fatalf("shares = %s", shares)
		}
	})

	t.Run("most specific share wins", func(t *testing.T) {
		sub := create(alice, "/api/folders", `{"name":"Board","parentId":"`+folder+`"}`)
		expect(bob, "POST", "/api/pages", `{"name":"ok","html":"x","folderId":"`+sub+`"}`, http.StatusCreated)
		expect(alice, "PUT", "/api/folders/"+sub+"/acl", `{"email":"`+bob+`","role":"viewer"}`, http.StatusNoContent)
		expect(bob, "POST", "/api/pages", `{"name":"no","html":"x","folderId":"`+sub+`"}`, http.StatusForbidden)
	})

	t.Run("page share", func(t *testing.T) {
		expect(alice, "PUT", "/api/pages/"+private+"/acl", `{"email":"`+carol+`","role":"viewer"}`, http.StatusBadRequest)
		expect(carol, "GET", "/api/me", "", http.StatusOK)
		expect(alice, "PUT", "/api/pages/"+private+"/acl", `{"email":"`+carol+`","role":"viewer"}`, http.StatusNoContent)
		expect(carol, "GET", "/view/"+private, "", http.StatusOK)
		if meta := expect(alice, "GET", "/api/pages/"+private, "", http.StatusOK); !strings.Contains(meta, `"shared":true`) {
			t.Fatalf("alice's meta lacks the shared flag: %s", meta)
		}
		expect(carol, "GET", "/view/"+page, "", http.StatusNotFound)
	})

	t.Run("unshare", func(t *testing.T) {
		expect(alice, "DELETE", fAPI+"?sub="+bob, "", http.StatusNoContent)
		expect(bob, "GET", "/view/"+page, "", http.StatusNotFound)
		expect(bob, "GET", "/api/tree?parent="+folder, "", http.StatusNotFound)
		if shared := expect(bob, "GET", "/api/shared", "", http.StatusOK); roleIn(shared, folder) != "" {
			t.Fatalf("folder still shared: %s", shared)
		}
	})
}
