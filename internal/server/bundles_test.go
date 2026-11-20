package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"
	"github.com/danieles/specola/plugin"

	"github.com/jackc/pgx/v5/pgxpool"
)

// newBundleTestServer is newTestServer with cfg, also returning the database
// so tests can expire grants.
func newBundleTestServer(t *testing.T, cfg *config.Config) (*httptest.Server, *pgxpool.Pool) {
	t.Helper()
	pool := testdb.New(t)
	cfg.TrustedUserHeader = userHeader
	ts := httptest.NewServer(New(cfg, store.New(pool), nil, nil))
	t.Cleanup(ts.Close)
	return ts, pool
}

// send makes a request with a raw body and returns the status and body.
func send(t *testing.T, ts *httptest.Server, method, path string, body []byte) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func sum(content string) string {
	h := sha256.Sum256([]byte(content))
	return hex.EncodeToString(h[:])
}

// files is a bundle's content, by path.
type files map[string]string

func (f files) manifest(pluginVersion string) string {
	type entry struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
		Size   int    `json:"size"`
	}
	var es []entry
	for p, c := range f {
		es = append(es, entry{p, sum(c), len(c)})
	}
	b, _ := json.Marshal(map[string]any{"pluginVersion": pluginVersion, "files": es})
	return string(b)
}

// mintBundle asks the API for a bundle upload grant and returns the path of
// its upload URL.
func mintBundle(t *testing.T, ts *httptest.Server, user, req string) string {
	t.Helper()
	code, body := call(t, ts, user, "POST", "/api/bundle-uploads", req)
	if code != http.StatusCreated {
		t.Fatalf("mint %s: %d %s", req, code, body)
	}
	var g struct{ UploadURL, Command string }
	mustJSON(t, body, &g)
	u, err := url.Parse(g.UploadURL)
	if err != nil || !strings.HasPrefix(u.Path, "/upload/bundle/") {
		t.Fatalf("uploadUrl = %q", g.UploadURL)
	}
	return u.Path
}

// publishBundle uploads f through the grant at path and returns the commit's
// page id and version.
func publishBundle(t *testing.T, ts *httptest.Server, path string, f files, commit string) (string, int) {
	t.Helper()
	code, body := send(t, ts, "POST", path+"/manifest", []byte(f.manifest("1.0.0")))
	if code != http.StatusOK {
		t.Fatalf("manifest: %d %s", code, body)
	}
	var m struct{ Missing []string }
	mustJSON(t, body, &m)
	for _, c := range f {
		if slices.Contains(m.Missing, sum(c)) {
			if code, body := send(t, ts, "PUT", path+"/blobs/"+sum(c), []byte(c)); code != http.StatusNoContent {
				t.Fatalf("put: %d %s", code, body)
			}
		}
	}
	code, body = send(t, ts, "POST", path+"/commit", []byte(commit))
	if code != http.StatusCreated {
		t.Fatalf("commit: %d %s", code, body)
	}
	var r struct {
		ID      string
		Version int
		URL     string
	}
	mustJSON(t, body, &r)
	if r.URL != "http://test/#/p/"+r.ID && !strings.HasSuffix(r.URL, "/#/p/"+r.ID) {
		t.Fatalf("commit url = %q", r.URL)
	}
	return r.ID, r.Version
}

type filesResp struct {
	Bundle bool
	Base   string
	Files  []struct {
		Path, ContentType, SHA256 string
		Size                      int
	}
}

func versionFiles(t *testing.T, ts *httptest.Server, user, id string, v int) filesResp {
	t.Helper()
	code, body := call(t, ts, user, "GET", fmt.Sprintf("/api/pages/%s/versions/%d/files", id, v), "")
	if code != http.StatusOK {
		t.Fatalf("files: %d %s", code, body)
	}
	var r filesResp
	mustJSON(t, body, &r)
	return r
}

func TestBundleUploadProtocol(t *testing.T) {
	ts, pool := newBundleTestServer(t, &config.Config{AppBaseURL: "http://test"})
	const alice, bob = "alice@example.com", "bob@example.com"
	call(t, ts, bob, "GET", "/api/me", "")

	t.Run("minting", func(t *testing.T) {
		for _, req := range []string{`{"kind":"other"}`, `{"kind":"new"}`, `{"kind":"version"}`, `not json`} {
			if code, body := call(t, ts, alice, "POST", "/api/bundle-uploads", req); code != http.StatusBadRequest {
				t.Errorf("%s: %d %s, want 400", req, code, body)
			}
		}
		code, body := call(t, ts, alice, "POST", "/api/bundle-uploads", `{"kind":"new","title":"App","note":"first"}`)
		var g struct {
			UploadURL, Command, PluginInstall string
			ExpiresAt                         time.Time
		}
		mustJSON(t, body, &g)
		if code != http.StatusCreated || !strings.HasPrefix(g.UploadURL, "http://test/upload/bundle/") ||
			g.Command != "npx specola-publish --upload '"+g.UploadURL+"'" ||
			g.PluginInstall != "npm i -D http://test"+plugin.TarballPath() ||
			time.Until(g.ExpiresAt) < 29*time.Minute || time.Until(g.ExpiresAt) > 31*time.Minute {
			t.Fatalf("mint: %d %s", code, body)
		}
		code, body = call(t, ts, alice, "POST", "/api/pages", `{"name":"Mine","html":"<p>x</p>"}`)
		mine := createdID(t, code, body)
		if code, _ := call(t, ts, bob, "POST", "/api/bundle-uploads", `{"kind":"version","id":"`+mine+`"}`); code != http.StatusNotFound {
			t.Fatalf("bob on alice's page: %d, want 404", code)
		}
	})

	t.Run("info", func(t *testing.T) {
		path := mintBundle(t, ts, alice, `{"kind":"new","title":"App"}`)
		code, body := send(t, ts, "GET", path, nil)
		var info struct {
			Kind, Title, PageID, MinPluginVersion string
			ExpiresAt                             time.Time
			Limits                                map[string]int
		}
		mustJSON(t, body, &info)
		if code != http.StatusOK || info.Kind != "new" || info.Title != "App" || info.PageID != "" || info.MinPluginVersion != minPluginVersion ||
			info.Limits["maxFiles"] != 2000 || info.Limits["maxFileBytes"] != 25<<20 ||
			info.Limits["maxIndexBytes"] != 5<<20 || info.Limits["maxBundleBytes"] != 100<<20 {
			t.Fatalf("info: %d %s", code, body)
		}
		if code, _ := send(t, ts, "GET", "/upload/bundle/nope", nil); code != http.StatusNotFound {
			t.Fatalf("unknown token: %d, want 404", code)
		}
	})

	app := files{
		"index.html":    `<script type="module" src="__SPECOLA_BASE__/assets/app.js"></script><p>Hello</p>`,
		"assets/app.js": `import "./dep.js"`,
		"assets/dep.js": `console.log("dep")`,
	}
	var page string

	t.Run("manifest, blobs, commit", func(t *testing.T) {
		path := mintBundle(t, ts, alice, `{"kind":"new","title":"App","note":"first"}`)
		for name, body := range map[string]string{
			"old plugin":      app.manifest("0.9.0"),
			"no plugin":       app.manifest(""),
			"no index.html":   files{"a.js": "x"}.manifest("1.0.0"),
			"extra html":      files{"index.html": "x", "b.html": "y"}.manifest("1.0.0"),
			"bad path":        files{"index.html": "x", "../a.js": "y"}.manifest("1.0.0"),
			"not json":        "{",
			"file too large":  strings.Replace(app.manifest("1.0.0"), fmt.Sprintf(`"size":%d`, len(app["assets/dep.js"])), fmt.Sprintf(`"size":%d`, 25<<20+1), 1),
			"index too large": strings.Replace(app.manifest("1.0.0"), fmt.Sprintf(`"size":%d`, len(app["index.html"])), fmt.Sprintf(`"size":%d`, 5<<20+1), 1),
		} {
			if code, got := send(t, ts, "POST", path+"/manifest", []byte(body)); code != http.StatusBadRequest {
				t.Errorf("%s: %d %s, want 400", name, code, got)
			}
		}
		if _, got := send(t, ts, "POST", path+"/manifest", []byte(app.manifest("0.9.0"))); !strings.Contains(got, "@specola/vite-plugin with npm i -D http://test/tools/specola-vite-plugin-") {
			t.Errorf("old plugin message %q doesn't say what to update", got)
		}

		code, body := send(t, ts, "POST", path+"/manifest", []byte(app.manifest("1.2.0-beta.1")))
		var m struct{ Missing []string }
		mustJSON(t, body, &m)
		if code != http.StatusOK || len(m.Missing) != 3 {
			t.Fatalf("manifest: %d %s", code, body)
		}

		dep := app["assets/dep.js"]
		for name, put := range map[string][2]string{
			"wrong hash":   {sum(dep), strings.ToUpper(dep[:1]) + dep[1:]},
			"unknown hash": {sum("other"), "other"},
			"wrong size":   {sum(dep), dep + " "},
		} {
			if code, got := send(t, ts, "PUT", path+"/blobs/"+put[0], []byte(put[1])); code != http.StatusBadRequest {
				t.Errorf("%s: %d %s, want 400", name, code, got)
			}
		}
		if code, _ := send(t, ts, "PUT", path+"/blobs/"+sum(dep), []byte(dep)); code != http.StatusNoContent {
			t.Fatalf("put dep: %d", code)
		}

		code, body = send(t, ts, "POST", path+"/commit", nil)
		var missing struct{ Missing []string }
		mustJSON(t, body, &missing)
		want := []string{sum(app["assets/app.js"]), sum(app["index.html"])}
		slices.Sort(want)
		if code != http.StatusConflict || !slices.Equal(missing.Missing, want) {
			t.Fatalf("commit with missing blobs: %d %s, want 409 with %v", code, body, want)
		}

		var v int
		page, v = publishBundle(t, ts, path, app, "")
		if v != 1 {
			t.Fatalf("version %d", v)
		}
		if code, _ := send(t, ts, "POST", path+"/commit", nil); code != http.StatusGone {
			t.Fatalf("second commit: %d, want 410", code)
		}
		for _, p := range []string{path, path + "/manifest"} {
			method := "GET"
			if strings.HasSuffix(p, "manifest") {
				method = "POST"
			}
			if code, _ := send(t, ts, method, p, []byte(app.manifest("1.0.0"))); code != http.StatusGone {
				t.Fatalf("%s %s after commit: %d, want 410", method, p, code)
			}
		}

		_, body = call(t, ts, alice, "GET", "/api/pages/"+page, "")
		var meta struct {
			Name   string
			Bundle bool
		}
		mustJSON(t, body, &meta)
		if meta.Name != "App" || !meta.Bundle {
			t.Fatalf("meta: %s", body)
		}
	})

	t.Run("new version uploads only what changed", func(t *testing.T) {
		path := mintBundle(t, ts, alice, `{"kind":"version","id":"`+page+`","note":"grant note"}`)
		code, body := send(t, ts, "GET", path, nil)
		if code != http.StatusOK || !strings.Contains(body, `"kind":"version"`) || !strings.Contains(body, `"pageId":"`+page+`"`) {
			t.Fatalf("info: %d %s", code, body)
		}
		next := files{"index.html": app["index.html"], "assets/app.js": app["assets/app.js"], "assets/new.js": "new"}
		_, body = send(t, ts, "POST", path+"/manifest", []byte(next.manifest("1.0.0")))
		var m struct{ Missing []string }
		mustJSON(t, body, &m)
		want := []string{sum("new"), sum(app["index.html"])}
		slices.Sort(want)
		if !slices.Equal(m.Missing, want) {
			t.Fatalf("missing = %v, want only the new file and index.html", m.Missing)
		}
		if id, v := publishBundle(t, ts, path, next, `{"note":"commit note"}`); id != page || v != 2 {
			t.Fatalf("commit = %s v%d", id, v)
		}
		_, body = call(t, ts, alice, "GET", "/api/pages/"+page+"/versions", "")
		var vs []struct {
			Version int
			Note    string
			Bundle  bool
		}
		mustJSON(t, body, &vs)
		if len(vs) != 2 || vs[0].Note != "commit note" || vs[1].Note != "first" || !vs[0].Bundle || !vs[1].Bundle {
			t.Fatalf("versions: %s", body)
		}
	})

	t.Run("token errors come first", func(t *testing.T) {
		for name, req := range map[string][3]string{
			"manifest, old plugin": {"POST", "/upload/bundle/nope/manifest", app.manifest("0.1.0")},
			"manifest, invalid":    {"POST", "/upload/bundle/nope/manifest", files{"a.js": "x"}.manifest("1.0.0")},
			"blob":                 {"PUT", "/upload/bundle/nope/blobs/" + sum("x"), "x"},
			"commit":               {"POST", "/upload/bundle/nope/commit", ""},
		} {
			if code, body := send(t, ts, req[0], req[1], []byte(req[2])); code != http.StatusNotFound {
				t.Errorf("%s: %d %s, want 404", name, code, body)
			}
		}
		path := mintBundle(t, ts, alice, `{"kind":"new","title":"Big"}`)
		big := files{"index.html": "<p>big</p>", "big.bin": strings.Repeat("x", 25<<20+1)}
		send(t, ts, "POST", path+"/manifest", []byte(files{"index.html": "<p>big</p>", "big.bin": "x"}.manifest("1.0.0")))
		if code, body := send(t, ts, "PUT", path+"/blobs/"+sum(big["big.bin"]), []byte(big["big.bin"])); code != http.StatusRequestEntityTooLarge {
			t.Errorf("body over the file limit: %d %s, want 413", code, body)
		}
		if code, body := send(t, ts, "PUT", path+"/blobs/"+sum("x"), []byte("xx")); code != http.StatusBadRequest {
			t.Errorf("body longer than its manifest entry: %d %s, want 400", code, body)
		}
	})

	t.Run("blobs of pages the uploader can't see must be sent", func(t *testing.T) {
		// bob uploads the same dep.js alice's page has: he must send it.
		path := mintBundle(t, ts, bob, `{"kind":"new","title":"Bob's"}`)
		f := files{"index.html": "<p>bob's</p>", "dep.js": app["assets/dep.js"]}
		_, body := send(t, ts, "POST", path+"/manifest", []byte(f.manifest("1.0.0")))
		var m struct{ Missing []string }
		mustJSON(t, body, &m)
		if !slices.Contains(m.Missing, sum(app["assets/dep.js"])) {
			t.Fatalf("missing = %v: alice's blob is offered to bob", m.Missing)
		}
		publishBundle(t, ts, path, f, "")
	})

	t.Run("expired grant", func(t *testing.T) {
		path := mintBundle(t, ts, alice, `{"kind":"version","id":"`+page+`"}`)
		if _, err := pool.Exec(t.Context(), `UPDATE asset_grant SET expires_at = now() - interval '1 second' WHERE bundle AND consumed_at IS NULL`); err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{"GET", "POST"} {
			p := path
			if method == "POST" {
				p += "/commit"
			}
			if code, _ := send(t, ts, method, p, nil); code != http.StatusGone {
				t.Fatalf("%s %s: %d, want 410", method, p, code)
			}
		}
	})

	t.Run("access lost between mint and commit", func(t *testing.T) {
		call(t, ts, alice, "PUT", "/api/pages/"+page+"/acl", `{"email":"`+bob+`","role":"editor"}`)
		path := mintBundle(t, ts, bob, `{"kind":"version","id":"`+page+`"}`)
		f := files{"index.html": "<p>bob</p>"}
		send(t, ts, "POST", path+"/manifest", []byte(f.manifest("1.0.0")))
		send(t, ts, "PUT", path+"/blobs/"+sum(f["index.html"]), []byte(f["index.html"]))
		call(t, ts, alice, "DELETE", "/api/pages/"+page+"/acl?sub="+bob, "")
		if code, body := send(t, ts, "POST", path+"/commit", nil); code != http.StatusNotFound {
			t.Fatalf("commit after unshare: %d %s, want 404", code, body)
		}
	})
}

func TestBundleServing(t *testing.T) {
	ts, _ := newBundleTestServer(t, &config.Config{AppBaseURL: "http://test"})
	const alice = "alice@example.com"
	index := `<!doctype html><link rel="stylesheet" href="__SPECOLA_BASE__/assets/s.css">` +
		`<script type="module" src="__SPECOLA_BASE__/assets/app.js"></script>`
	app := files{
		"index.html":           index,
		"assets/app.js":        `console.log("0123456789")`,
		"assets/s.css":         `body{}`,
		"assets/m.wasm":        "\x00asm",
		"assets/data.json":     `{}`,
		"img/logo.PNG":         "\x89PNG",
		"fonts/Inter Var.woff": "wOFF",
		"readme.unknown":       "?",
	}
	id, _ := publishBundle(t, ts, mintBundle(t, ts, alice, `{"kind":"new","title":"App"}`), app, "")
	fr := versionFiles(t, ts, alice, id, 1)
	if !fr.Bundle || !strings.HasPrefix(fr.Base, "http://test/b/") || !strings.HasSuffix(fr.Base, "/") || len(fr.Files) != len(app)-1 {
		t.Fatalf("files: %+v", fr)
	}
	for _, f := range fr.Files {
		if f.Path == "index.html" || f.SHA256 != sum(app[f.Path]) || f.Size != len(app[f.Path]) || f.ContentType != store.BundleContentType(f.Path) {
			t.Fatalf("file entry %+v", f)
		}
	}
	base := strings.TrimPrefix(fr.Base, "http://test")
	alicesHeaders := http.Header{userHeader: {alice}}

	t.Run("headers and types", func(t *testing.T) {
		res := get(t, ts, "", base+"assets/app.js", nil)
		if b := readBody(t, res); res.StatusCode != http.StatusOK || b != app["assets/app.js"] {
			t.Fatalf("app.js: %d %q", res.StatusCode, b)
		}
		for h, want := range map[string]string{
			"Content-Type":                 "text/javascript; charset=utf-8",
			"X-Content-Type-Options":       "nosniff",
			"Content-Security-Policy":      "sandbox allow-scripts allow-popups allow-forms allow-modals",
			"Access-Control-Allow-Origin":  "*",
			"Cross-Origin-Resource-Policy": "cross-origin",
			"Referrer-Policy":              "no-referrer",
			"Cache-Control":                "public, max-age=31536000, immutable",
			"ETag":                         `"` + sum(app["assets/app.js"]) + `"`,
		} {
			if got := res.Header.Get(h); got != want {
				t.Errorf("%s = %q, want %q", h, got, want)
			}
		}
		for p, want := range map[string]string{
			"assets/s.css":           "text/css; charset=utf-8",
			"assets/m.wasm":          "application/wasm",
			"assets/data.json":       "application/json",
			"img/logo.PNG":           "image/png",
			"fonts/Inter%20Var.woff": "font/woff",
			"readme.unknown":         "application/octet-stream",
		} {
			res := get(t, ts, "", base+p, nil)
			if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != want {
				t.Errorf("%s: %d %q, want %q", p, res.StatusCode, res.Header.Get("Content-Type"), want)
			}
		}
		res = get(t, ts, "", base+"assets/app.js", http.Header{"Accept-Encoding": {"gzip"}})
		if res.Header.Get("Content-Encoding") != "gzip" {
			t.Errorf("app.js isn't compressed: Content-Encoding %q", res.Header.Get("Content-Encoding"))
		}
		res = get(t, ts, "", base+"assets/app.js", http.Header{"If-None-Match": {`"` + sum(app["assets/app.js"]) + `"`}})
		if res.StatusCode != http.StatusNotModified {
			t.Fatalf("If-None-Match: %d, want 304", res.StatusCode)
		}
	})

	t.Run("head", func(t *testing.T) {
		req, _ := http.NewRequest("HEAD", ts.URL+base+"assets/app.js", nil)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "text/javascript; charset=utf-8" ||
			res.ContentLength != int64(len(app["assets/app.js"])) {
			t.Fatalf("HEAD: %d %q %d", res.StatusCode, res.Header.Get("Content-Type"), res.ContentLength)
		}
		req, _ = http.NewRequest("HEAD", ts.URL+base+"nope.js", nil)
		if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusNotFound {
			t.Fatalf("HEAD of a missing file: %v %v, want 404", res, err)
		}
	})

	t.Run("range", func(t *testing.T) {
		res := get(t, ts, "", base+"assets/app.js", http.Header{"Range": {"bytes=0-6"}, "Accept-Encoding": {"gzip"}})
		if b := readBody(t, res); res.StatusCode != http.StatusPartialContent || b != "console" ||
			res.Header.Get("Content-Range") != fmt.Sprintf("bytes 0-6/%d", len(app["assets/app.js"])) || res.Header.Get("Content-Encoding") != "" {
			t.Fatalf("range: %d %q, Content-Range %q, Content-Encoding %q", res.StatusCode, b, res.Header.Get("Content-Range"), res.Header.Get("Content-Encoding"))
		}
	})

	t.Run("not found", func(t *testing.T) {
		for _, p := range []string{base + "nope.js", base + "index.html", "/b/not-a-key/assets/app.js", base} {
			if res := get(t, ts, "", p, nil); res.StatusCode != http.StatusNotFound {
				t.Errorf("%s: %d, want 404", p, res.StatusCode)
			}
		}
	})

	t.Run("placeholder is replaced where the page is served", func(t *testing.T) {
		want := func(basename string) string {
			return withSDK(strings.ReplaceAll(index, "__SPECOLA_BASE__/", fr.Base), bootData{Base: fr.Base, Basename: basename})
		}
		for _, p := range []string{"/view/" + id, "/view/" + id + "?v=1", "/view/" + id + "/deep/path?q=1"} {
			if res := get(t, ts, "", p, alicesHeaders); readBody(t, res) != want("/view/"+id) {
				t.Fatalf("%s: body isn't the index with the base replaced", p)
			}
		}
		_, body := call(t, ts, alice, "POST", "/api/pages/"+id+"/links", `{}`)
		var l struct{ URL string }
		mustJSON(t, body, &l)
		linkPath := strings.TrimPrefix(l.URL, "http://test")
		if got := readBody(t, get(t, ts, "", linkPath+"/deep/path", nil)); got != want(linkPath) {
			t.Fatalf("public link: %q", got)
		}
		// The stored HTML keeps the placeholder.
		_, body = call(t, ts, alice, "GET", "/api/pages/"+id+"/versions", "")
		if !strings.Contains(body, `"bundle":true`) {
			t.Fatalf("versions: %s", body)
		}
	})

	t.Run("archived page", func(t *testing.T) {
		call(t, ts, alice, "POST", "/api/pages/"+id+"/archive", "")
		if res := get(t, ts, "", base+"assets/app.js", nil); res.StatusCode != http.StatusNotFound {
			t.Fatalf("archived: %d, want 404", res.StatusCode)
		}
		call(t, ts, alice, "POST", "/api/pages/"+id+"/unarchive", "")
		if res := get(t, ts, "", base+"assets/app.js", nil); res.StatusCode != http.StatusOK {
			t.Fatalf("unarchived: %d, want 200", res.StatusCode)
		}
	})

	t.Run("restore and plain versions", func(t *testing.T) {
		if code, body := call(t, ts, alice, "POST", "/api/pages/"+id+"/versions", `{"html":"<p>plain __SPECOLA_BASE__/x</p>"}`); code != http.StatusCreated {
			t.Fatalf("plain version: %d %s", code, body)
		}
		if fr := versionFiles(t, ts, alice, id, 2); fr.Bundle || fr.Base != "" || fr.Files == nil || len(fr.Files) != 0 {
			t.Fatalf("plain files: %+v", fr)
		}
		_, body := call(t, ts, alice, "GET", "/api/pages/"+id, "")
		if !strings.Contains(body, `"bundle":false`) {
			t.Fatalf("meta after plain version: %s", body)
		}
		// A plain page's HTML is served as stored.
		if got := readBody(t, get(t, ts, "", "/view/"+id, alicesHeaders)); got != served("<p>plain __SPECOLA_BASE__/x</p>", "/view/"+id) {
			t.Fatalf("plain view: %q", got)
		}

		if code, body := call(t, ts, alice, "POST", "/api/pages/"+id+"/versions", `{"restoreFrom":1}`); code != http.StatusCreated {
			t.Fatalf("restore: %d %s", code, body)
		}
		fr3 := versionFiles(t, ts, alice, id, 3)
		if !fr3.Bundle || fr3.Base == fr.Base || len(fr3.Files) != len(fr.Files) {
			t.Fatalf("restored files: %+v", fr3)
		}
		for i := range fr.Files {
			if fr3.Files[i] != fr.Files[i] {
				t.Fatalf("restored file %d: %+v, was %+v", i, fr3.Files[i], fr.Files[i])
			}
		}
		want := withSDK(strings.ReplaceAll(index, "__SPECOLA_BASE__/", fr3.Base), bootData{Base: fr3.Base, Basename: "/view/" + id})
		if got := readBody(t, get(t, ts, "", "/view/"+id, alicesHeaders)); got != want {
			t.Fatalf("restored view: %q", got)
		}
		if res := get(t, ts, "", strings.TrimPrefix(fr3.Base, "http://test")+"assets/app.js", nil); res.StatusCode != http.StatusOK {
			t.Fatalf("restored file: %d", res.StatusCode)
		}
	})

	t.Run("files API needs access", func(t *testing.T) {
		if code, _ := call(t, ts, "stranger@example.com", "GET", "/api/pages/"+id+"/versions/1/files", ""); code != http.StatusNotFound {
			t.Fatalf("stranger: %d, want 404", code)
		}
		for _, v := range []string{"0", "x", "99"} {
			if code, _ := call(t, ts, alice, "GET", "/api/pages/"+id+"/versions/"+v+"/files", ""); code == http.StatusOK {
				t.Fatalf("version %s: 200", v)
			}
		}
	})
}

func TestBundleOnViewOrigin(t *testing.T) {
	cfg := &config.Config{
		AppBaseURL:    "https://specola.test",
		ViewOrigin:    viewOrigin,
		SessionSecret: "test-secret-test-secret-test-secret",
	}
	ts, _ := newBundleTestServer(t, cfg)
	const alice, viewHost = "alice@example.com", "view.specola.test"
	index := `<script type="module" src="__SPECOLA_BASE__/app.js"></script>`
	id, _ := publishBundle(t, ts, mintBundle(t, ts, alice, `{"kind":"new","title":"App"}`), files{"index.html": index, "app.js": "1"}, "")

	fr := versionFiles(t, ts, alice, id, 1)
	if !strings.HasPrefix(fr.Base, viewOrigin+"/b/") {
		t.Fatalf("base = %q, want it on the view origin", fr.Base)
	}
	path := strings.TrimPrefix(fr.Base, viewOrigin) + "app.js"
	if res := get(t, ts, viewHost, path, nil); res.StatusCode != http.StatusOK || readBody(t, res) != "1" {
		t.Fatalf("view origin: %d", res.StatusCode)
	}
	if res := get(t, ts, "", path, http.Header{userHeader: {alice}}); res.StatusCode != http.StatusNotFound || readBody(t, res) == "1" {
		t.Fatalf("app origin: %d, want 404", res.StatusCode)
	}
	head, _ := http.NewRequest("HEAD", ts.URL+path, nil)
	if res, err := http.DefaultClient.Do(head); err != nil || res.StatusCode != http.StatusNotFound {
		t.Fatalf("HEAD on the app origin: %v %v, want 404", res, err)
	}

	want := func(basename string) string {
		return withSDK(strings.ReplaceAll(index, "__SPECOLA_BASE__/", fr.Base), bootData{Base: fr.Base, Basename: basename})
	}
	_, body := call(t, ts, alice, "GET", "/api/pages/"+id, "")
	var meta struct{ ViewURL string }
	mustJSON(t, body, &meta)
	u, _ := url.Parse(meta.ViewURL)
	if got := readBody(t, get(t, ts, viewHost, u.Path+"/deep", nil)); got != want(u.Path) {
		t.Fatalf("token view: %q", got)
	}
	_, body = call(t, ts, alice, "POST", "/api/pages/"+id+"/links", `{}`)
	var l struct{ URL string }
	mustJSON(t, body, &l)
	linkPath := strings.TrimPrefix(l.URL, viewOrigin)
	if got := readBody(t, get(t, ts, viewHost, linkPath, nil)); got != want(linkPath) {
		t.Fatalf("public link: %q", got)
	}
}
