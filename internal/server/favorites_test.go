package server

import (
	"net/http"
	"testing"
)

func TestFavorites(t *testing.T) {
	ts := newTestServer(t)
	const alice, bob = "alice@example.com", "bob@example.com"
	call(t, ts, bob, "GET", "/api/me", "") // so alice can share with bob

	code, body := call(t, ts, alice, "POST", "/api/folders", `{"name":"Reports"}`)
	folder := createdID(t, code, body)
	code, body = call(t, ts, alice, "POST", "/api/pages", `{"name":"Q3","html":"<p>q3</p>","folderId":"`+folder+`"}`)
	page := createdID(t, code, body)

	favorites := func(user string) map[string]bool {
		t.Helper()
		code, body := call(t, ts, user, "GET", "/api/favorites", "")
		if code != http.StatusOK {
			t.Fatalf("favorites: %d %s", code, body)
		}
		var items []struct {
			ID       string
			Favorite bool
		}
		mustJSON(t, body, &items)
		got := map[string]bool{}
		for _, it := range items {
			if !it.Favorite {
				t.Fatalf("favorites lists %s without favorite set", it.ID)
			}
			got[it.ID] = true
		}
		return got
	}
	star := func(user, method, path string, want int) {
		t.Helper()
		if code, body := call(t, ts, user, method, path, ""); code != want {
			t.Fatalf("%s %s as %s: %d %s, want %d", method, path, user, code, body, want)
		}
	}

	// Starring is idempotent, and shows in listings and page metadata.
	star(alice, "PUT", "/api/pages/"+page+"/favorite", http.StatusNoContent)
	star(alice, "PUT", "/api/pages/"+page+"/favorite", http.StatusNoContent)
	star(alice, "PUT", "/api/folders/"+folder+"/favorite", http.StatusNoContent)
	if f := favorites(alice); len(f) != 2 || !f[page] || !f[folder] {
		t.Fatalf("alice's favorites = %v", f)
	}
	_, body = call(t, ts, alice, "GET", "/api/tree", "")
	var root []struct {
		ID       string
		Favorite bool
	}
	mustJSON(t, body, &root)
	if len(root) != 1 || root[0].ID != folder || !root[0].Favorite {
		t.Fatalf("tree = %+v", root)
	}
	_, body = call(t, ts, alice, "GET", "/api/pages/"+page, "")
	var meta struct{ Favorite bool }
	mustJSON(t, body, &meta)
	if !meta.Favorite {
		t.Fatal("page meta: favorite not set")
	}

	// Stars are personal, and need sight of the item.
	if f := favorites(bob); len(f) != 0 {
		t.Fatalf("bob sees alice's stars: %v", f)
	}
	star(bob, "PUT", "/api/pages/"+page+"/favorite", http.StatusNotFound)
	if code, body := call(t, ts, alice, "PUT", "/api/pages/"+page+"/acl", `{"email":"`+bob+`","role":"viewer"}`); code != http.StatusNoContent {
		t.Fatalf("share: %d %s", code, body)
	}
	star(bob, "PUT", "/api/pages/"+page+"/favorite", http.StatusNoContent)
	if f := favorites(bob); len(f) != 1 || !f[page] {
		t.Fatalf("bob's favorites = %v", f)
	}

	// Losing access hides the star without dropping it.
	star(alice, "DELETE", "/api/pages/"+page+"/acl?sub="+bob, http.StatusNoContent)
	if f := favorites(bob); len(f) != 0 {
		t.Fatalf("unshared page still in bob's favorites: %v", f)
	}
	call(t, ts, alice, "PUT", "/api/pages/"+page+"/acl", `{"email":"`+bob+`","role":"viewer"}`)
	if f := favorites(bob); len(f) != 1 {
		t.Fatalf("star not back with the share: %v", f)
	}

	// Archiving the folder hides both stars; restoring it brings them back.
	star(alice, "POST", "/api/folders/"+folder+"/archive", http.StatusNoContent)
	if f := favorites(alice); len(f) != 0 {
		t.Fatalf("archived items in favorites: %v", f)
	}
	star(alice, "POST", "/api/folders/"+folder+"/unarchive", http.StatusNoContent)
	if f := favorites(alice); len(f) != 2 {
		t.Fatalf("favorites after restore = %v", f)
	}

	star(alice, "DELETE", "/api/pages/"+page+"/favorite", http.StatusNoContent)
	star(alice, "DELETE", "/api/pages/"+page+"/favorite", http.StatusNoContent)
	if f := favorites(alice); len(f) != 1 || !f[folder] {
		t.Fatalf("after unstar = %v", f)
	}
}
