package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/webui"

	"github.com/go-chi/chi/v5"
)

// Page apps (docs/page-apps.md): a page installed on its own as a
// Progressive Web App. A signed-in app is served at /app/{id}/ on the app
// origin: the SPA's shell with the app's head (manifest, name, colors,
// icon), which shows the page alone, full screen.

// defaultThemeColor is Specola's own, for a page that sets none.
const defaultThemeColor = "#0b0d12"

// appLook is how an app looks: its name, colors and icon.
type appLook struct {
	Name            string
	ShortName       string
	Display         string
	ThemeColor      string
	BackgroundColor string
	// Icon is the icon's URL with "{size}" for its size: generated icons
	// come in 192 and 512.
	Icon         string
	IconMaskable bool
}

// iconURL is the app's icon at size.
func (l appLook) iconURL(size int) string {
	return strings.Replace(l.Icon, "{size}", strconv.Itoa(size), 1)
}

// routesApps registers the signed-in apps' routes, which need the session.
func (s *Server) routesApps(r chi.Router) {
	r.Get("/app/{id}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/"+url.PathEscape(chi.URLParam(r, "id"))+"/", http.StatusMovedPermanently)
	})
	r.Get("/app/{id}/", s.handleAppShell)
	r.Get("/app/{id}/manifest.webmanifest", s.handleAppManifest)
}

// routesAppIcons registers the icons, which need nothing: a generated icon
// tells nothing that isn't in its URL.
func routesAppIcons(r chi.Router) {
	r.Get("/app-icons/g/{color}/{letter}/{size}", handleGeneratedIcon)
	r.Handle("/app-icons/*", http.NotFoundHandler())
}

// appLookOf works out how a page's app looks, from its name and its current
// version.
func (s *Server) appLookOf(ctx context.Context, sub string, meta *store.PageMeta) (appLook, error) {
	content, err := s.st.CurrentContent(ctx, sub, meta.ID)
	if err != nil {
		return appLook{}, err
	}
	theme := themeColorOf(content)
	if theme == "" {
		theme = defaultThemeColor
	}
	name := strings.TrimSpace(meta.Name)
	if name == "" {
		name = "Page"
	}
	return appLook{
		Name:            name,
		ShortName:       shortName(name),
		Display:         "standalone",
		ThemeColor:      theme,
		BackgroundColor: theme,
		Icon:            generatedIcon(meta.ID, name),
		IconMaskable:    true,
	}, nil
}

func (s *Server) handleAppShell(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	meta, err := s.st.PageMeta(ctx, subOf(ctx), chi.URLParam(r, "id"))
	if errors.Is(err, store.ErrNotFound) {
		// The SPA says so, as it does for any page it can't open.
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write(webui.Index())
		return
	}
	if err != nil {
		w.Header().Del("Cache-Control")
		httpError(w, err)
		return
	}
	look, err := s.appLookOf(ctx, subOf(ctx), meta)
	if err != nil {
		w.Header().Del("Cache-Control")
		httpError(w, err)
		return
	}
	_, _ = w.Write(appShell(webui.Index(), look, "/app/"+meta.ID+"/manifest.webmanifest", true))
}

// appManifest is a web app manifest, as page apps write it.
type appManifest struct {
	ID              string         `json:"id"`
	StartURL        string         `json:"start_url"`
	Scope           string         `json:"scope"`
	Name            string         `json:"name"`
	ShortName       string         `json:"short_name"`
	Display         string         `json:"display"`
	ThemeColor      string         `json:"theme_color"`
	BackgroundColor string         `json:"background_color"`
	Icons           []manifestIcon `json:"icons"`
}

type manifestIcon struct {
	Src     string `json:"src"`
	Sizes   string `json:"sizes"`
	Type    string `json:"type"`
	Purpose string `json:"purpose"`
}

// manifestOf is the manifest of an app at base (its id, start and scope).
func manifestOf(base string, l appLook) appManifest {
	m := appManifest{
		ID: base, StartURL: base, Scope: base,
		Name: l.Name, ShortName: l.ShortName, Display: l.Display,
		ThemeColor: l.ThemeColor, BackgroundColor: l.BackgroundColor,
	}
	for _, size := range []int{192, 512} {
		m.Icons = append(m.Icons, manifestIcon{Src: l.iconURL(size), Sizes: strconv.Itoa(size) + "x" + strconv.Itoa(size), Type: "image/png", Purpose: "any"})
	}
	if l.IconMaskable {
		m.Icons = append(m.Icons, manifestIcon{Src: l.iconURL(512), Sizes: "512x512", Type: "image/png", Purpose: "maskable"})
	}
	return m
}

func (s *Server) handleAppManifest(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	meta, err := s.st.PageMeta(ctx, subOf(ctx), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	look, err := s.appLookOf(ctx, subOf(ctx), meta)
	if err != nil {
		httpError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	writeManifest(w, manifestOf("/app/"+meta.ID+"/", look))
}

func writeManifest(w http.ResponseWriter, m appManifest) {
	w.Header().Set("Content-Type", "application/manifest+json")
	writeJSON(w, http.StatusOK, m)
}

// The tags of the SPA's head an app replaces with its own.
var appHeadTags = regexp.MustCompile(`(?is)<title>.*?</title>\s*|` +
	`<link\s[^>]*rel\s*=\s*["']?(?:manifest|icon|apple-touch-icon)(?:["'\s/][^>]*)?>\s*|` +
	`<meta\s[^>]*name\s*=\s*["']?(?:theme-color|apple-mobile-web-app-title)(?:["'\s/][^>]*)?>\s*`)

var headEnd = regexp.MustCompile(`(?i)</head>`)

// appShell is the SPA's shell index with the app's head: its manifest (with
// credentials when it needs the session), name, colors and icons. iOS reads
// the name and icon from these tags, not from the manifest.
func appShell(index []byte, l appLook, manifest string, credentials bool) []byte {
	var tags strings.Builder
	tags.WriteString(`<link rel="manifest" href="` + html.EscapeString(manifest) + `"`)
	if credentials {
		tags.WriteString(` crossorigin="use-credentials"`)
	}
	tags.WriteString(">\n")
	tags.WriteString(`<title>` + html.EscapeString(l.Name) + "</title>\n")
	tags.WriteString(`<meta name="theme-color" content="` + html.EscapeString(l.ThemeColor) + "\">\n")
	tags.WriteString(`<meta name="apple-mobile-web-app-title" content="` + html.EscapeString(l.ShortName) + "\">\n")
	tags.WriteString(`<link rel="icon" type="image/png" href="` + html.EscapeString(l.iconURL(192)) + "\">\n")
	tags.WriteString(`<link rel="apple-touch-icon" href="` + html.EscapeString(l.iconURL(512)) + "\">\n")

	out := appHeadTags.ReplaceAll(index, nil)
	if loc := headEnd.FindIndex(out); loc != nil {
		return bytes.Join([][]byte{out[:loc[0]], []byte(tags.String()), out[loc[0]:]}, nil)
	}
	return append([]byte(tags.String()), out...)
}

var (
	themeMeta  = regexp.MustCompile(`(?is)<meta\s[^>]*name\s*=\s*["']?theme-color(?:["'\s/][^>]*)?>`)
	contentAtt = regexp.MustCompile(`(?is)\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	hexColor   = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)
)

// themeColorOf is the first <meta name="theme-color"> of a page, as
// #rrggbb, or "" when it has none in that form.
func themeColorOf(page string) string {
	tag := themeMeta.FindString(page)
	if tag == "" {
		return ""
	}
	m := contentAtt.FindStringSubmatch(tag)
	if m == nil {
		return ""
	}
	c := strings.TrimSpace(m[1] + m[2] + m[3])
	if !hexColor.MatchString(c) {
		return ""
	}
	c = strings.ToLower(c)
	if len(c) == 4 {
		c = "#" + strings.Repeat(c[1:2], 2) + strings.Repeat(c[2:3], 2) + strings.Repeat(c[3:4], 2)
	}
	return c
}

// shortName is name cut to 12 characters, at a word boundary when there is
// one: what fits under an icon.
func shortName(name string) string {
	const max = 12
	if utf8.RuneCountInString(name) <= max {
		return name
	}
	r := []rune(name)[:max]
	if i := strings.LastIndexFunc(string(r), unicode.IsSpace); i > 0 {
		return strings.TrimSpace(string(r)[:i])
	}
	return string(r)
}

// generatedIcon is the URL format ({size} in it) of a page's generated
// icon: the first letter or digit of its name on a color picked from its
// id, so two apps on one device are told apart.
func generatedIcon(id, name string) string {
	sum := sha256.Sum256([]byte(id))
	color := iconPalette[int(sum[0])%len(iconPalette)]
	return "/app-icons/g/" + color + "/" + url.PathEscape(string(iconLetter(name))) + "/{size}.png"
}
