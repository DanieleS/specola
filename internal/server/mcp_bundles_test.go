package server

import (
	"strings"
	"testing"
	"time"

	"github.com/danieles/specola/plugin"
)

func TestMCPBundles(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()
	const app = "http://specola.test"
	install := "npm i -D " + app + "/tools/" + plugin.TarballName

	// The instructions steer apps with a build step to the plugin, with this
	// instance's own install command.
	ins := cs.InitializeResult().Instructions
	for _, want := range []string{"publish_page", install, "specola()", "create_bundle_upload", "window.specola?.basename", "IndexedDB is unavailable"} {
		if !strings.Contains(ins, want) {
			t.Errorf("instructions lack %q", want)
		}
	}

	type upload struct {
		UploadURL     string    `json:"upload_url"`
		ExpiresAt     time.Time `json:"expires_at"`
		Command       string    `json:"command"`
		PluginInstall string    `json:"plugin_install"`
	}
	var up upload
	callTool(t, cs, "create_bundle_upload", map[string]any{"kind": "new", "title": "App", "note": "first build"}, &up)
	path, ok := strings.CutPrefix(up.UploadURL, app+"/upload/bundle/")
	if !ok || up.Command != "npx specola-publish --upload '"+up.UploadURL+"'" || up.PluginInstall != install ||
		time.Until(up.ExpiresAt) < 29*time.Minute || time.Until(up.ExpiresAt) > 31*time.Minute {
		t.Fatalf("create_bundle_upload = %+v", up)
	}
	index := `<script type="module" src="__SPECOLA_BASE__/assets/app.js"></script>`
	id, _ := publishBundle(t, ts, "/upload/bundle/"+path, files{"index.html": index, "assets/app.js": "1", "data.json": "{}"}, "")

	type page struct {
		Version     int
		HTML        string
		HTMLVersion int `json:"html_version"`
		Bundle      *struct {
			Base  string
			Files []struct {
				Path        string
				Size        int
				ContentType string `json:"content_type"`
			}
		}
		Note string
	}
	var p page
	callTool(t, cs, "get_page", map[string]any{"id": id}, &p)
	if p.HTML != index || p.Bundle == nil || !strings.HasPrefix(p.Bundle.Base, app+"/b/") || !strings.HasSuffix(p.Bundle.Base, "/") ||
		len(p.Bundle.Files) != 2 || p.Bundle.Files[0].Path != "assets/app.js" || p.Bundle.Files[0].Size != 1 ||
		p.Bundle.Files[0].ContentType != "text/javascript; charset=utf-8" || !strings.Contains(p.Note, "create_bundle_upload") {
		t.Fatalf("get_page on a bundle = %+v", p)
	}

	// A new version of the bundle, then a plain one.
	callTool(t, cs, "create_bundle_upload", map[string]any{"kind": "version", "id": id}, &up)
	publishBundle(t, ts, strings.TrimPrefix(up.UploadURL, app), files{"index.html": index, "assets/app.js": "2"}, `{"note":"second"}`)
	callTool(t, cs, "new_version", map[string]any{"id": id, "html": "<p>plain</p>"}, nil)

	var vs struct {
		Versions []struct {
			Version int
			Bundle  bool
			Note    string
		}
	}
	callTool(t, cs, "list_versions", map[string]any{"id": id}, &vs)
	if len(vs.Versions) != 3 || vs.Versions[0].Bundle || !vs.Versions[1].Bundle || vs.Versions[1].Note != "second" ||
		!vs.Versions[2].Bundle || vs.Versions[2].Note != "first build" {
		t.Fatalf("list_versions = %+v", vs)
	}
	p = page{}
	callTool(t, cs, "get_page", map[string]any{"id": id}, &p)
	if p.HTML != "<p>plain</p>" || p.Bundle != nil || p.Note != "" {
		t.Fatalf("get_page on a plain version = %+v", p)
	}
	p = page{}
	callTool(t, cs, "get_page", map[string]any{"id": id, "version": 2}, &p)
	if p.HTMLVersion != 2 || p.Version != 3 || p.Bundle == nil || len(p.Bundle.Files) != 1 {
		t.Fatalf("get_page version 2 = %+v", p)
	}

	// Mistakes and other people's pages are errors.
	cases := map[string]map[string]any{
		"bad kind":       {"kind": "page"},
		"no title":       {"kind": "new"},
		"no id":          {"kind": "version"},
		"unknown page":   {"kind": "version", "id": "00000000-0000-0000-0000-000000000000"},
		"unknown folder": {"kind": "new", "title": "X", "folder_id": "00000000-0000-0000-0000-000000000000"},
	}
	for name, args := range cases {
		if res := callTool(t, cs, "create_bundle_upload", args, nil); !res.IsError {
			t.Errorf("%s: no error", name)
		}
	}
	bob, err := connect(t, ts, fi.token(t, "bob", testResource))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer bob.Close()
	if res := callTool(t, bob, "create_bundle_upload", map[string]any{"kind": "version", "id": id}, nil); !res.IsError {
		t.Fatal("bob got an upload link for alice's page")
	}
}
