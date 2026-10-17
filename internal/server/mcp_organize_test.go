package server

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestMCPToolAnnotations(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()

	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	readOnly := map[string]bool{"list": true, "get_page": true, "list_versions": true, "search": true, "list_public_links": true}
	seen := map[string]bool{}
	for _, tool := range tools.Tools {
		seen[tool.Name] = true
		got := tool.Annotations != nil && tool.Annotations.ReadOnlyHint
		if got != readOnly[tool.Name] {
			t.Errorf("%s: readOnlyHint = %v, want %v", tool.Name, got, readOnly[tool.Name])
		}
	}
	for _, want := range []string{"create_folder", "rename", "move", "archive", "unarchive", "list_versions", "create_public_link", "list_public_links", "revoke_public_link"} {
		if !seen[want] {
			t.Errorf("tool %s missing", want)
		}
	}
}

func TestMCPOrganize(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()

	type item struct {
		ID, Kind, Name, URL string
	}
	list := func(args map[string]any) []item {
		t.Helper()
		var out struct{ Items []item }
		callTool(t, cs, "list", args, &out)
		return out.Items
	}
	ok := func(name string, args map[string]any) {
		t.Helper()
		if res := callTool(t, cs, name, args, nil); res.IsError {
			t.Fatalf("%s %v: %v", name, args, res.Content)
		}
	}
	fails := func(name string, args map[string]any) {
		t.Helper()
		if res := callTool(t, cs, name, args, nil); !res.IsError {
			t.Fatalf("%s %v succeeded, want an error", name, args)
		}
	}

	var folder struct{ ID string }
	callTool(t, cs, "create_folder", map[string]any{"name": " Viaggi "}, &folder)
	var pub struct{ ID string }
	callTool(t, cs, "publish_page", map[string]any{"title": "Report", "html": "<p>v1</p>", "note": "first cut"}, &pub)

	// Move into the folder, rename there.
	ok("move", map[string]any{"kind": "page", "id": pub.ID, "folder_id": folder.ID})
	ok("rename", map[string]any{"kind": "page", "id": pub.ID, "name": "Report ottobre"})
	inside := list(map[string]any{"folder_id": folder.ID})
	if len(inside) != 1 || inside[0].ID != pub.ID || inside[0].Name != "Report ottobre" {
		t.Fatalf("folder holds %+v", inside)
	}
	if root := list(map[string]any{}); len(root) != 1 || root[0].Name != "Viaggi" {
		t.Fatalf("root = %+v", root)
	}

	// Versions with notes, and reading an earlier one.
	callTool(t, cs, "new_version", map[string]any{"id": pub.ID, "html": "<p>v2</p>", "note": "October data"}, nil)
	var vs struct {
		Versions []struct {
			Version int
			Note    string
		}
	}
	callTool(t, cs, "list_versions", map[string]any{"id": pub.ID}, &vs)
	if len(vs.Versions) != 2 || vs.Versions[0].Note != "October data" || vs.Versions[1].Note != "first cut" {
		t.Fatalf("list_versions = %+v", vs)
	}
	var old struct {
		Version     int
		HTML        string
		HTMLVersion int `json:"html_version"`
	}
	callTool(t, cs, "get_page", map[string]any{"id": pub.ID, "version": 1}, &old)
	if old.HTML != "<p>v1</p>" || old.HTMLVersion != 1 || old.Version != 2 {
		t.Fatalf("get_page version 1 = %+v", old)
	}
	fails("get_page", map[string]any{"id": pub.ID, "version": 9})

	// Archive the folder: gone from the root, listed as archived without a
	// link; unarchive brings it back with the page inside.
	ok("archive", map[string]any{"kind": "folder", "id": folder.ID})
	if root := list(map[string]any{}); len(root) != 0 {
		t.Fatalf("root after archive = %+v", root)
	}
	if got := list(map[string]any{"archived": true}); len(got) != 1 || got[0].ID != folder.ID || got[0].URL != "" {
		t.Fatalf("archived = %+v", got)
	}
	ok("unarchive", map[string]any{"kind": "folder", "id": folder.ID})
	if inside := list(map[string]any{"folder_id": folder.ID}); len(inside) != 1 {
		t.Fatalf("folder after unarchive = %+v", inside)
	}

	// Back to the root: folder_id omitted.
	ok("move", map[string]any{"kind": "page", "id": pub.ID})
	if root := list(map[string]any{}); len(root) != 2 {
		t.Fatalf("root after move out = %+v", root)
	}

	// Mistakes come back as tool errors an agent can read.
	fails("move", map[string]any{"kind": "folder", "id": folder.ID, "folder_id": folder.ID})
	fails("rename", map[string]any{"kind": "file", "id": pub.ID, "name": "x"})
	fails("rename", map[string]any{"kind": "page", "id": pub.ID, "name": "  "})
	fails("create_folder", map[string]any{"name": ""})
	fails("list", map[string]any{"archived": true, "shared_with_me": true})

	// Another user can't touch alice's items.
	other, err := connect(t, ts, fi.token(t, "bob", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	for name, args := range map[string]map[string]any{
		"rename":  {"kind": "page", "id": pub.ID, "name": "mine now"},
		"archive": {"kind": "folder", "id": folder.ID},
	} {
		res := callTool(t, other, name, args, nil)
		if !res.IsError {
			t.Fatalf("bob's %s succeeded", name)
		}
	}
}

func TestMCPUploadGrantNote(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()

	var g struct {
		UploadURL string `json:"upload_url"`
	}
	callTool(t, cs, "create_upload_grant", map[string]any{"kind": "new", "title": "Big", "note": "uploaded"}, &g)
	path := strings.TrimPrefix(g.UploadURL, "http://specola.test")
	code, body := call(t, ts, "", "PUT", path, "<p>big</p>")
	if code != http.StatusCreated {
		t.Fatalf("upload: %d %s", code, body)
	}
	var up struct{ ID string }
	mustJSON(t, body, &up)

	var vs struct{ Versions []struct{ Note string } }
	callTool(t, cs, "list_versions", map[string]any{"id": up.ID}, &vs)
	if len(vs.Versions) != 1 || vs.Versions[0].Note != "uploaded" {
		t.Fatalf("versions = %+v", vs)
	}
}

func TestMCPPublicLinks(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()

	var pub struct{ ID string }
	callTool(t, cs, "publish_page", map[string]any{"title": "Deck", "html": "<p>deck</p>"}, &pub)

	var link struct{ ID, URL, Label string }
	callTool(t, cs, "create_public_link", map[string]any{"id": pub.ID, "label": "client", "expires_in_days": 3}, &link)
	if link.ID == "" || link.Label != "client" || !strings.HasPrefix(link.URL, "http://specola.test/s/") {
		t.Fatalf("create_public_link = %+v", link)
	}
	path := strings.TrimPrefix(link.URL, "http://specola.test")
	if res := get(t, ts, "", path, nil); res.StatusCode != http.StatusOK || readBody(t, res) != withSDK("<p>deck</p>") {
		t.Fatalf("open: %d", res.StatusCode)
	}

	var listed struct {
		Links []struct {
			ID    string
			Views int
		}
	}
	callTool(t, cs, "list_public_links", map[string]any{"id": pub.ID}, &listed)
	if len(listed.Links) != 1 || listed.Links[0].ID != link.ID || listed.Links[0].Views != 1 {
		t.Fatalf("list_public_links = %+v", listed)
	}
	if res := callTool(t, cs, "create_public_link", map[string]any{"id": pub.ID, "version": 5}, nil); !res.IsError {
		t.Fatal("pinning a missing version succeeded")
	}

	if res := callTool(t, cs, "revoke_public_link", map[string]any{"id": pub.ID, "link_id": link.ID}, nil); res.IsError {
		t.Fatalf("revoke: %v", res.Content)
	}
	if res := get(t, ts, "", path, nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("revoked: %d, want 404", res.StatusCode)
	}
}
