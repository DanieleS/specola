package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/pageapp"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"

	"github.com/modelcontextprotocol/go-sdk/mcp"
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
	var m pageapp.Manifest
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
	var m pageapp.Manifest
	mustJSON(t, body, &m)
	if code != http.StatusOK || m.ThemeColor != pageapp.DefaultThemeColor || m.ShortName != "¿über" ||
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
	l := pageapp.Look{Name: "A", ShortName: "A", ThemeColor: "#123456", Icon: "/i/{size}.png"}
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
	var m pageapp.Manifest
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

func TestAppSettingsAPI(t *testing.T) {
	pool := testdb.New(t)
	st := store.New(pool)
	ts := httptest.NewServer(New(&config.Config{AppBaseURL: "http://test", TrustedUserHeader: userHeader}, st, nil, nil))
	t.Cleanup(ts.Close)
	const alice, bob = "alice@example.com", "bob@example.com"
	call(t, ts, bob, "GET", "/api/me", "")
	id := publishPage(t, ts, alice, "Budget", `<meta name="theme-color" content="#0f766e"><p>b</p>`)
	if code, body := call(t, ts, alice, "PUT", "/api/pages/"+id+"/acl", `{"email":"`+bob+`","role":"viewer"}`); code != http.StatusNoContent {
		t.Fatalf("share: %d %s", code, body)
	}
	app := "/api/pages/" + id + "/app"

	get := func(user string) appSettingsResp {
		t.Helper()
		code, body := call(t, ts, user, "GET", app, "")
		if code != http.StatusOK {
			t.Fatalf("GET as %s: %d %s", user, code, body)
		}
		var r appSettingsResp
		mustJSON(t, body, &r)
		return r
	}
	r := get(bob)
	if r.CanEdit || r.Settings.Name != nil || r.Effective.Name != "Budget" || r.Effective.ThemeColor != "#0f766e" || r.URL != "/app/"+id+"/" {
		t.Fatalf("defaults: %+v", r)
	}
	if code, _ := call(t, ts, bob, "PUT", app, `{"name":"Mine"}`); code != http.StatusForbidden {
		t.Fatalf("a viewer changes it: %d", code)
	}

	code, body := call(t, ts, alice, "PUT", app, `{"name":"Team budget","shortName":"Budget","display":"fullscreen","themeColor":"#112233"}`)
	mustJSON(t, body, &r)
	if code != http.StatusOK || !r.CanEdit || *r.Settings.Name != "Team budget" || r.Effective.Display != "fullscreen" ||
		r.Effective.ThemeColor != "#112233" || r.Effective.BackgroundColor != "#112233" {
		t.Fatalf("set: %d %+v", code, r)
	}
	// Fields left out stay; null resets one.
	call(t, ts, alice, "PUT", app, `{"shortName":null}`)
	if r = get(alice); *r.Settings.Name != "Team budget" || r.Settings.ShortName != nil || r.Effective.ShortName != "Team budget" {
		t.Fatalf("partial: %+v", r)
	}
	for _, bad := range []string{`{"themeColor":"#ABC"}`, `{"display":"browser"}`, `{"nope":1}`, `{"name":"` + strings.Repeat("x", 61) + `"}`, `{"iconMaskable":"yes"}`} {
		if code, _ := call(t, ts, alice, "PUT", app, bad); code != http.StatusBadRequest {
			t.Errorf("%s: %d", bad, code)
		}
	}

	// Both apps follow: the signed-in one and a public link's.
	_, body = call(t, ts, alice, "GET", "/app/"+id+"/manifest.webmanifest", "")
	var m pageapp.Manifest
	mustJSON(t, body, &m)
	if m.Name != "Team budget" || m.Display != "fullscreen" || m.ThemeColor != "#112233" {
		t.Fatalf("manifest: %+v", m)
	}
	code, body = call(t, ts, alice, "POST", "/api/pages/"+id+"/links", `{}`)
	var l struct{ URL string }
	mustJSON(t, body, &l)
	mustJSON(t, readBody(t, get2(t, ts, strings.TrimPrefix(l.URL, "http://test")+"/~app.webmanifest")), &m)
	if m.Name != "Team budget" || m.Display != "fullscreen" {
		t.Fatalf("public manifest: %+v", m)
	}

	// An icon: a square PNG of 512 or more.
	upload := func(user string, b []byte) (int, string) {
		t.Helper()
		req, _ := http.NewRequest("PUT", ts.URL+app+"/icon", bytes.NewReader(b))
		req.Header.Set(userHeader, user)
		res := mustDo(t, req)
		return res.StatusCode, readBody(t, res)
	}
	if code, _ := upload(alice, pngBytes(t, 256)); code != http.StatusBadRequest {
		t.Fatalf("a small icon: %d", code)
	}
	if code, _ := upload(bob, pngBytes(t, 512)); code != http.StatusForbidden {
		t.Fatalf("a viewer's icon: %d", code)
	}
	icon := pngBytes(t, 600)
	code, body = upload(alice, icon)
	mustJSON(t, body, &r)
	if code != http.StatusOK || r.Settings.Icon == nil || r.Effective.Icon != *r.Settings.Icon || r.Effective.IconMaskable {
		t.Fatalf("upload: %d %+v", code, r)
	}
	res := get2(t, ts, *r.Settings.Icon)
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "image/png" || readBody(t, res) != string(icon) {
		t.Fatalf("serve icon: %d", res.StatusCode)
	}
	_, body = call(t, ts, alice, "GET", "/app/"+id+"/manifest.webmanifest", "")
	mustJSON(t, body, &m)
	if len(m.Icons) != 1 || m.Icons[0].Sizes != "600x600" || m.Icons[0].Src != *r.Settings.Icon {
		t.Fatalf("manifest icons: %+v", m.Icons)
	}
	call(t, ts, alice, "PUT", app, `{"iconMaskable":true}`)
	_, body = call(t, ts, alice, "GET", "/app/"+id+"/manifest.webmanifest", "")
	mustJSON(t, body, &m)
	if len(m.Icons) != 2 || m.Icons[1].Purpose != "maskable" {
		t.Fatalf("maskable: %+v", m.Icons)
	}
	// The blob sweep keeps it.
	if n, err := st.SweepBundleBlobs(context.Background(), 0); err != nil || n != 0 {
		t.Fatalf("sweep: %d %v", n, err)
	}
	if res := get2(t, ts, *r.Settings.Icon); res.StatusCode != http.StatusOK {
		t.Fatalf("after the sweep: %d", res.StatusCode)
	}

	// Back to the generated icon: the uploaded one isn't served any more.
	iconURL := *r.Settings.Icon
	code, body = call(t, ts, alice, "DELETE", app+"/icon", "")
	mustJSON(t, body, &r)
	if code != http.StatusOK || r.Settings.Icon != nil || !strings.HasPrefix(r.Effective.Icon, "/app-icons/g/") {
		t.Fatalf("delete icon: %d %+v", code, r)
	}
	if res := get2(t, ts, iconURL); res.StatusCode != http.StatusNotFound {
		t.Fatalf("an unused icon: %d", res.StatusCode)
	}

	// Reset: every default again.
	code, body = call(t, ts, alice, "DELETE", app, "")
	mustJSON(t, body, &r)
	if code != http.StatusOK || r.Settings.Name != nil || r.Effective.Name != "Budget" || r.Effective.Display != "standalone" {
		t.Fatalf("reset: %d %+v", code, r)
	}
}

func get2(t *testing.T, ts *httptest.Server, path string) *http.Response {
	t.Helper()
	return get(t, ts, "", path, nil)
}

func pngBytes(t *testing.T, size int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	img.Set(1, 1, color.RGBA{R: 200, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestMCPSetPageApp(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()

	var pub struct {
		ID     string `json:"id"`
		AppURL string `json:"app_url"`
	}
	callTool(t, cs, "publish_page", map[string]any{"title": "Quiz night", "html": "<p>quiz</p>"}, &pub)
	if pub.AppURL != "http://specola.test/app/"+pub.ID+"/" {
		t.Fatalf("publish_page app_url = %q", pub.AppURL)
	}
	var got struct {
		AppURL string `json:"app_url"`
	}
	callTool(t, cs, "get_page", map[string]any{"id": pub.ID}, &got)
	if got.AppURL != pub.AppURL {
		t.Fatalf("get_page app_url = %q", got.AppURL)
	}

	var out pageAppOutForTest
	callTool(t, cs, "set_page_app", map[string]any{
		"id": pub.ID, "name": "Quiz", "display": "fullscreen", "theme_color": "#4338ca",
		"icon_png_base64": base64.StdEncoding.EncodeToString(pngBytes(t, 512)), "icon_maskable": true,
	}, &out)
	if out.Name != "Quiz" || out.ShortName != "Quiz" || out.Display != "fullscreen" || out.ThemeColor != "#4338ca" ||
		!out.IconMaskable || !strings.HasPrefix(out.Icon, "http://specola.test/app-icons/") || strings.Contains(out.Icon, "/g/") ||
		out.AppURL != pub.AppURL {
		t.Fatalf("set_page_app = %+v", out)
	}
	// "" resets; the generated icon again.
	callTool(t, cs, "set_page_app", map[string]any{"id": pub.ID, "name": "", "generated_icon": true}, &out)
	if out.Name != "Quiz night" || out.Display != "fullscreen" || !strings.Contains(out.Icon, "/app-icons/g/") {
		t.Fatalf("reset = %+v", out)
	}
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "set_page_app", Arguments: map[string]any{"id": pub.ID, "theme_color": "blue"}})
	if err != nil || !res.IsError {
		t.Fatalf("a bad color: %v %+v", err, res)
	}
}

type pageAppOutForTest struct {
	Name         string `json:"name"`
	ShortName    string `json:"short_name"`
	Display      string `json:"display"`
	ThemeColor   string `json:"theme_color"`
	Icon         string `json:"icon"`
	IconMaskable bool   `json:"icon_maskable"`
	AppURL       string `json:"app_url"`
}
