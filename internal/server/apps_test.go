package server

import (
	"bytes"
	"encoding/json"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// publishPage publishes a page as user and returns its id.
func publishPage(t *testing.T, ts *httptest.Server, user, name, html string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"name": name, "html": html})
	code, res := call(t, ts, user, "POST", "/api/pages", string(body))
	if code != http.StatusCreated {
		t.Fatalf("create page: %d %s", code, res)
	}
	var page struct{ ID string }
	mustJSON(t, res, &page)
	return page.ID
}

func TestAppShellAndManifest(t *testing.T) {
	ts := newTestServer(t)
	const alice, bob = "alice", "bob"
	id := publishPage(t, ts, alice, "Budget 2027 & more",
		`<!doctype html><head><meta name="theme-color" content="#1E40AF"></head><p>hi</p>`)

	code, body := call(t, ts, alice, "GET", "/app/"+id+"/", "")
	if code != http.StatusOK {
		t.Fatalf("shell: %d %s", code, body)
	}
	for _, want := range []string{
		`<link rel="manifest" href="/app/` + id + `/manifest.webmanifest" crossorigin="use-credentials">`,
		`<title>Budget 2027 &amp; more</title>`,
		`<meta name="theme-color" content="#1e40af">`,
		`<meta name="apple-mobile-web-app-title" content="Budget 2027">`,
		`<link rel="apple-touch-icon" href="/app-icons/g/`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("shell lacks %s:\n%s", want, body)
		}
	}
	if strings.Count(body, "<title>") != 1 || strings.Contains(body, "Specola</title>") {
		t.Errorf("shell keeps Specola's title:\n%s", body)
	}

	code, body = call(t, ts, alice, "GET", "/app/"+id+"/manifest.webmanifest", "")
	if code != http.StatusOK {
		t.Fatalf("manifest: %d %s", code, body)
	}
	var m appManifest
	mustJSON(t, body, &m)
	base := "/app/" + id + "/"
	if m.ID != base || m.StartURL != base || m.Scope != base || m.Name != "Budget 2027 & more" ||
		m.ShortName != "Budget 2027" || m.Display != "standalone" || m.ThemeColor != "#1e40af" || m.BackgroundColor != "#1e40af" {
		t.Errorf("manifest: %+v", m)
	}
	if len(m.Icons) != 3 || m.Icons[2].Purpose != "maskable" || !strings.HasSuffix(m.Icons[0].Src, "/B/192.png") {
		t.Fatalf("icons: %+v", m.Icons)
	}

	// The icon is there, with no session, at its size.
	res := get(t, ts, "", m.Icons[1].Src, nil)
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "image/png" ||
		!strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("icon: %d %v", res.StatusCode, res.Header)
	}
	img, err := png.Decode(strings.NewReader(readBody(t, res)))
	if err != nil || img.Bounds().Dx() != 512 || img.Bounds().Dy() != 512 {
		t.Fatalf("icon image: %v %v", err, img)
	}

	// Without access: 404, as everywhere. The shell still answers, without
	// the app's head, so the SPA can say so.
	if code, _ := call(t, ts, bob, "GET", "/app/"+id+"/manifest.webmanifest", ""); code != http.StatusNotFound {
		t.Errorf("manifest for bob: %d", code)
	}
	code, body = call(t, ts, bob, "GET", "/app/"+id+"/", "")
	if code != http.StatusNotFound || strings.Contains(body, "manifest.webmanifest\" crossorigin") {
		t.Errorf("shell for bob: %d %s", code, body)
	}

	// The page's meta says where its app is.
	code, body = call(t, ts, alice, "GET", "/api/pages/"+id, "")
	var meta struct{ AppURL string }
	mustJSON(t, body, &meta)
	if code != http.StatusOK || meta.AppURL != base {
		t.Errorf("appUrl: %d %q", code, meta.AppURL)
	}
}

func TestAppDefaultsAndPaths(t *testing.T) {
	ts := newTestServer(t)
	const alice = "alice"
	id := publishPage(t, ts, alice, "  ¿über", `<p>no theme</p>`)

	code, body := call(t, ts, alice, "GET", "/app/"+id+"/manifest.webmanifest", "")
	var m appManifest
	mustJSON(t, body, &m)
	if code != http.StatusOK || m.ThemeColor != defaultThemeColor || m.ShortName != "¿über" ||
		!strings.Contains(m.Icons[0].Src, "/%C3%9C/") {
		t.Errorf("defaults: %d %+v", code, m)
	}
	if res := get(t, ts, "", m.Icons[0].Src, nil); res.StatusCode != http.StatusOK {
		t.Errorf("escaped letter icon: %d", res.StatusCode)
	}

	// /app/{id} goes to /app/{id}/; nothing else under /app/ is the SPA.
	req, _ := http.NewRequest("GET", ts.URL+"/app/"+id, nil)
	req.Header.Set(userHeader, alice)
	res, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusMovedPermanently || res.Header.Get("Location") != "/app/"+id+"/" {
		t.Errorf("redirect: %d %s", res.StatusCode, res.Header.Get("Location"))
	}
	for _, p := range []string{"/app/", "/app/" + id + "/other", "/app/" + id + "/x/y"} {
		if code, _ := call(t, ts, alice, "GET", p, ""); code != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, code)
		}
	}
}

func TestGeneratedIconsRefuseOtherURLs(t *testing.T) {
	ts := newTestServer(t)
	for _, p := range []string{
		"/app-icons/g/123456/A/512.png", // not in the palette
		"/app-icons/g/1d4ed8/a/512.png", // lower case
		"/app-icons/g/1d4ed8/AB/512.png",
		"/app-icons/g/1d4ed8/%21/512.png",
		"/app-icons/g/1d4ed8/A/100.png",
		"/app-icons/g/1d4ed8/%E4%B8%AD/512.png", // not in the font
		"/app-icons/other",
	} {
		if res := get(t, ts, "", p, nil); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, res.StatusCode)
		}
	}
	res := get(t, ts, "", "/app-icons/g/1d4ed8/7/192.png", nil)
	b := []byte(readBody(t, res))
	if res.StatusCode != http.StatusOK || !bytes.HasPrefix(b, []byte("\x89PNG")) {
		t.Errorf("digit icon: %d", res.StatusCode)
	}
}

func TestThemeColorOf(t *testing.T) {
	for in, want := range map[string]string{
		`<meta name="theme-color" content="#ABC">`:                                         "#aabbcc",
		`<META content='#0f766e' NAME=theme-color>`:                                        "#0f766e",
		`<meta name="theme-color" content="rebeccapurple">`:                                "",
		`<meta name="theme-color-x" content="#000000">`:                                    "",
		`<meta name="description" content="#123456"><p>`:                                   "",
		`<meta name="theme-color" content="#111"><meta name="theme-color" content="#222">`: "#111111",
	} {
		if got := themeColorOf(in); got != want {
			t.Errorf("themeColorOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestShortName(t *testing.T) {
	for in, want := range map[string]string{
		"Budget":                 "Budget",
		"Budget 2027 & more":     "Budget 2027",
		"Supercalifragilistic":   "Supercalifra",
		"Ünïcödé ñames longer x": "Ünïcödé",
	} {
		if got := shortName(in); got != want {
			t.Errorf("shortName(%q) = %q, want %q", in, got, want)
		}
	}
}

// The SPA's own index (web/index.html, as built): every tag an app has its
// own of goes, and the rest stays.
func TestAppShellReplacesTheSPAHead(t *testing.T) {
	index := `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#0b0d12" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <title>Specola</title>
    <script type="module" crossorigin src="/assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-abc.css">
  </head>
  <body><div id="app"></div></body>
</html>`
	l := appLook{Name: "A", ShortName: "A", ThemeColor: "#123456", Icon: "/i/{size}.png"}
	out := string(appShell([]byte(index), l, "/m", true))
	for _, gone := range []string{"/favicon.svg", "/icons/apple-touch-icon.png", `href="/manifest.webmanifest"`, "Specola", "#0b0d12"} {
		if strings.Contains(out, gone) {
			t.Errorf("kept %s:\n%s", gone, out)
		}
	}
	for _, kept := range []string{`name="viewport"`, "apple-mobile-web-app-capable", "/assets/index-abc.js", "/assets/index-abc.css",
		`<link rel="icon" type="image/png" href="/i/192.png">`, `<link rel="apple-touch-icon" href="/i/512.png">`} {
		if !strings.Contains(out, kept) {
			t.Errorf("lacks %s:\n%s", kept, out)
		}
	}
}

func TestPublicAppManifestAndWorker(t *testing.T) {
	ts := newTestServer(t)
	id := publishPage(t, ts, "alice", "Shared board", `<meta name="theme-color" content="#be185d"><p>hi</p>`)
	code, body := call(t, ts, "alice", "POST", "/api/pages/"+id+"/links", `{}`)
	var l struct{ URL string }
	mustJSON(t, body, &l)
	path := strings.TrimPrefix(l.URL, "http://test")
	if code != http.StatusCreated || !strings.HasPrefix(path, "/s/") {
		t.Fatalf("link: %d %s", code, body)
	}

	// No session: the token is the credential.
	res := get(t, ts, "", path+"/~app.webmanifest", nil)
	var m appManifest
	mustJSON(t, readBody(t, res), &m)
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "application/manifest+json" ||
		m.ID != path+"/" || m.StartURL != path+"/" || m.Scope != path || m.Name != "Shared board" || m.ThemeColor != "#be185d" {
		t.Fatalf("manifest: %d %+v", res.StatusCode, m)
	}

	res = get(t, ts, "", "/public-sw.js", nil)
	if b := readBody(t, res); res.StatusCode != http.StatusOK || !strings.HasPrefix(res.Header.Get("Content-Type"), "text/javascript") ||
		res.Header.Get("Cache-Control") != "no-cache" || !strings.Contains(b, `"offline":true`) {
		t.Fatalf("worker: %d %v", res.StatusCode, res.Header)
	}

	// Revoked: gone, manifest and all.
	var links []struct{ ID string }
	_, body = call(t, ts, "alice", "GET", "/api/pages/"+id+"/links", "")
	mustJSON(t, body, &links)
	call(t, ts, "alice", "DELETE", "/api/pages/"+id+"/links/"+links[0].ID, "")
	for _, p := range []string{path, path + "/~app.webmanifest", path + "/~page"} {
		if res := get(t, ts, "", p, nil); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s after revoking: %d", p, res.StatusCode)
		}
	}
}
