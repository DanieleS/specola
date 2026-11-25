package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/danieles/specola/internal/pageapp"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/webui"

	"github.com/go-chi/chi/v5"
)

// Page apps (docs/page-apps.md): a page installed on its own as a
// Progressive Web App. A signed-in app is served at /app/{id}/ on the app
// origin: the SPA's shell with the app's head (manifest, name, colors,
// icon), which shows the page alone, full screen.

// routesApps registers the signed-in apps' routes, which need the session.
func (s *Server) routesApps(r chi.Router) {
	r.Get("/app/{id}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/app/"+url.PathEscape(chi.URLParam(r, "id"))+"/", http.StatusMovedPermanently)
	})
	r.Get("/app/{id}/", s.handleAppShell)
	r.Get("/app/{id}/manifest.webmanifest", s.handleAppManifest)
}

// routesAppIcons registers the icons, which need nothing: a generated icon
// tells nothing that isn't in its URL, an uploaded one is named by its
// content's sha256.
func (s *Server) routesAppIcons(r chi.Router) {
	r.Get("/app-icons/g/{color}/{letter}/{size}", handleGeneratedIcon)
	r.Get("/app-icons/{file}", s.handleUploadedIcon)
	r.Handle("/app-icons/*", http.NotFoundHandler())
}

// appLookOf works out how a page's app looks: its author's settings, the
// rest from its name and its current version.
func (s *Server) appLookOf(ctx context.Context, sub string, meta *store.PageMeta) (pageapp.Look, error) {
	content, err := s.st.CurrentContent(ctx, sub, meta.ID)
	if err != nil {
		return pageapp.Look{}, err
	}
	settings, err := s.st.AppSettings(ctx, meta.ID)
	if err != nil {
		return pageapp.Look{}, err
	}
	return pageapp.LookOf(meta.ID, meta.Name, content, settings), nil
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
	base := "/app/" + meta.ID + "/"
	writeManifest(w, pageapp.ManifestOf(base, base, look))
}

func writeManifest(w http.ResponseWriter, m pageapp.Manifest) {
	b, err := json.Marshal(m)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/manifest+json")
	_, _ = w.Write(b)
}

// The tags of the SPA's head an app replaces with its own.
var appHeadTags = regexp.MustCompile(`(?is)<title>.*?</title>\s*|` +
	`<link\s[^>]*rel\s*=\s*["']?(?:manifest|icon|apple-touch-icon)(?:["'\s/][^>]*)?>\s*|` +
	`<meta\s[^>]*name\s*=\s*["']?(?:theme-color|apple-mobile-web-app-title)(?:["'\s/][^>]*)?>\s*`)

var headEnd = regexp.MustCompile(`(?i)</head>`)

// appShell is the SPA's shell index with the app's head: its manifest (with
// credentials when it needs the session), name, colors and icons. iOS reads
// the name and icon from these tags, not from the manifest.
func appShell(index []byte, l pageapp.Look, manifest string, credentials bool) []byte {
	var tags strings.Builder
	tags.WriteString(`<link rel="manifest" href="` + html.EscapeString(manifest) + `"`)
	if credentials {
		tags.WriteString(` crossorigin="use-credentials"`)
	}
	tags.WriteString(">\n")
	tags.WriteString(`<title>` + html.EscapeString(l.Name) + "</title>\n")
	tags.WriteString(`<meta name="theme-color" content="` + html.EscapeString(l.ThemeColor) + "\">\n")
	tags.WriteString(`<meta name="apple-mobile-web-app-title" content="` + html.EscapeString(l.ShortName) + "\">\n")
	tags.WriteString(`<link rel="icon" type="image/png" href="` + html.EscapeString(l.IconURL(192)) + "\">\n")
	tags.WriteString(`<link rel="apple-touch-icon" href="` + html.EscapeString(l.IconURL(512)) + "\">\n")

	out := appHeadTags.ReplaceAll(index, nil)
	if loc := headEnd.FindIndex(out); loc != nil {
		return bytes.Join([][]byte{out[:loc[0]], []byte(tags.String()), out[loc[0]:]}, nil)
	}
	return append([]byte(tags.String()), out...)
}

// appSettingsResp is GET /api/pages/{id}/app: the settings as set (null:
// the default), the look in effect, where the app is, and whether the
// caller may change it.
type appSettingsResp struct {
	Settings  appSettingsJSON `json:"settings"`
	Effective appEffective    `json:"effective"`
	URL       string          `json:"url"`
	CanEdit   bool            `json:"canEdit"`
}

type appSettingsJSON struct {
	Name            *string `json:"name"`
	ShortName       *string `json:"shortName"`
	Display         *string `json:"display"`
	Orientation     *string `json:"orientation"`
	ThemeColor      *string `json:"themeColor"`
	BackgroundColor *string `json:"backgroundColor"`
	IconMaskable    bool    `json:"iconMaskable"`
	// Icon is the uploaded icon's URL; null for the generated one.
	Icon *string `json:"icon"`
}

type appEffective struct {
	Name            string `json:"name"`
	ShortName       string `json:"shortName"`
	Display         string `json:"display"`
	Orientation     string `json:"orientation,omitempty"`
	ThemeColor      string `json:"themeColor"`
	BackgroundColor string `json:"backgroundColor"`
	Icon            string `json:"icon"`
	IconMaskable    bool   `json:"iconMaskable"`
}

func orNull(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// appSettingsOf answers a page's app settings to sub.
func (s *Server) appSettingsOf(ctx context.Context, sub, id string) (*appSettingsResp, error) {
	meta, err := s.st.PageMeta(ctx, sub, id)
	if err != nil {
		return nil, err
	}
	look, err := s.appLookOf(ctx, sub, meta)
	if err != nil {
		return nil, err
	}
	st, err := s.st.AppSettings(ctx, meta.ID)
	if err != nil {
		return nil, err
	}
	var icon *string
	if st.Icon != "" {
		icon = orNull(pageapp.UploadedIcon(st.Icon))
	}
	return &appSettingsResp{
		Settings: appSettingsJSON{
			Name: orNull(st.Name), ShortName: orNull(st.ShortName), Display: orNull(st.Display),
			Orientation: orNull(st.Orientation), ThemeColor: orNull(st.ThemeColor),
			BackgroundColor: orNull(st.BackgroundColor), IconMaskable: st.IconMaskable, Icon: icon,
		},
		Effective: appEffective{
			Name: look.Name, ShortName: look.ShortName, Display: look.Display, Orientation: look.Orientation,
			ThemeColor: look.ThemeColor, BackgroundColor: look.BackgroundColor,
			Icon: look.IconURL(512), IconMaskable: look.IconMaskable,
		},
		URL:     "/app/" + meta.ID + "/",
		CanEdit: meta.Role == "owner" || meta.Role == "editor",
	}, nil
}

func (s *Server) writeAppSettings(w http.ResponseWriter, r *http.Request) {
	resp, err := s.appSettingsOf(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleAppSettings(w http.ResponseWriter, r *http.Request) { s.writeAppSettings(w, r) }

// ParseAppSettingsChange reads a change of app settings: any of name,
// shortName, display, orientation, themeColor, backgroundColor (a string,
// or null for the default) and iconMaskable (a boolean). Fields left out
// stay as they are.
func ParseAppSettingsChange(raw map[string]json.RawMessage) (store.AppSettingsChange, error) {
	var c store.AppSettingsChange
	fields := map[string]**string{
		"name": &c.Name, "shortName": &c.ShortName, "display": &c.Display, "orientation": &c.Orientation,
		"themeColor": &c.ThemeColor, "backgroundColor": &c.BackgroundColor,
	}
	for k, v := range raw {
		if k == "iconMaskable" {
			var b bool
			if err := json.Unmarshal(v, &b); err != nil {
				return c, errors.New("iconMaskable must be true or false")
			}
			c.IconMaskable = &b
			continue
		}
		dst, ok := fields[k]
		if !ok {
			return c, errors.New("unknown setting " + strconvQuote(k))
		}
		var str *string
		if err := json.Unmarshal(v, &str); err != nil {
			return c, errors.New(k + " must be a string, or null for the default")
		}
		if str == nil {
			str = new(string)
		}
		*dst = str
	}
	return c, nil
}

func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

func (s *Server) handleSetAppSettings(w http.ResponseWriter, r *http.Request) {
	var raw map[string]json.RawMessage
	if !decode(w, r, &raw) {
		return
	}
	c, err := ParseAppSettingsChange(raw)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if _, err := s.st.SetAppSettings(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"), c); err != nil {
		httpError(w, err)
		return
	}
	s.writeAppSettings(w, r)
}

func (s *Server) handleResetApp(w http.ResponseWriter, r *http.Request) {
	if err := s.st.ResetApp(r.Context(), subOf(r.Context()), chi.URLParam(r, "id")); err != nil {
		httpError(w, err)
		return
	}
	s.writeAppSettings(w, r)
}

// handleSetAppIcon takes a PNG body: square, at least 512 × 512, at most
// 1 MiB (pageapp.CheckIcon).
func (s *Server) handleSetAppIcon(w http.ResponseWriter, r *http.Request) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, pageapp.MaxIconBytes+1))
	if err != nil {
		http.Error(w, "the icon can be at most 1 MB", http.StatusRequestEntityTooLarge)
		return
	}
	if _, err := s.st.SetAppIcon(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"), b, nil); err != nil {
		httpError(w, err)
		return
	}
	s.writeAppSettings(w, r)
}

func (s *Server) handleDeleteAppIcon(w http.ResponseWriter, r *http.Request) {
	if _, err := s.st.DeleteAppIcon(r.Context(), subOf(r.Context()), chi.URLParam(r, "id")); err != nil {
		httpError(w, err)
		return
	}
	s.writeAppSettings(w, r)
}
