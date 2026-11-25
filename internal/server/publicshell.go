package server

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/pageapp"
	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Public links (docs/page-backends.md, "Public links"; docs/page-apps.md,
// "Public apps"). /s/{token} serves a small shell (publicshell.html) that
// frames the page, served at /s/{token}/~page/…, and plays the viewer's side
// of the port: calls go to ANY /p/{token}/x/… and pushes come from
// GET /p/{token}/events, on the same origin, without a session. Only the
// routes the manifest declares public reach the runner, as an anonymous
// caller (role "public"), rate limited per link and per client IP. The shell
// is also the link's installable app: its own manifest, name and icon, and a
// service worker (publicsw.js) that keeps it for offline.

// publicShellHTML is the shell; its boot data replaces shellBootPlaceholder.
//
//go:embed publicshell.html
var publicShellHTML string

// shellBootPlaceholder is where the shell takes its boot data.
const shellBootPlaceholder = "SPECOLA_SHELL_BOOT"

// shellCSP is the shell's own policy: its inline script, the framed page
// (from its origin, or the copy kept offline), calls to its own origin, its
// manifest, icon and service worker, nothing else.
const shellCSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src 'self' blob:; connect-src 'self'; " +
	"style-src 'unsafe-inline'; manifest-src 'self'; img-src 'self'; worker-src 'self'"

//go:embed publicsw.js
var publicSW string

const (
	// Public calls a minute, per link and client IP, and per link.
	publicCallsPerIP   = 60
	publicCallsPerLink = 600
)

// routesPublic registers the public links' routes on the router that
// serves them: the view origin's when there is one, else the app's.
func (s *Server) routesPublic(r chi.Router) {
	r.Get("/s/{token}", s.handlePublicShell)
	r.Get("/s/{token}/*", s.handlePublicShell)
	r.Get("/s/{token}/~page", s.handlePublicPage)
	r.Get("/s/{token}/~page/*", s.handlePublicPage)
	r.Get("/s/{token}/~app.webmanifest", s.handlePublicManifest)
	// Other names under ~ are Specola's, not the page's.
	r.Get("/s/{token}/~*", http.NotFound)
	r.Get("/public-sw.js", handlePublicSW)
	r.HandleFunc("/p/{token}/x", s.handlePublicCall)
	r.HandleFunc("/p/{token}/x/*", s.handlePublicCall)
	r.Get("/p/{token}/events", s.handlePublicEvents)
	// The visitor's page data (visitors.go).
	r.Post("/p/{token}/visitor", s.handleNewVisitor)
	r.Get("/p/{token}/data", s.handleVisitorData)
	r.Patch("/p/{token}/data", s.handleUpdateVisitorData)
	r.Delete("/p/{token}/data", s.handleUpdateVisitorData)
	// Anything else under /p/ is not a page of the app.
	r.HandleFunc("/p/*", http.NotFound)
}

// shellBoot is the shell's boot data.
type shellBoot struct {
	Token   string       `json:"token"`
	Version int          `json:"version"`
	Backend backendState `json:"backend"`
	PageSrc string       `json:"pageSrc"`
	// HasBackend: the version shown has a backend. Bundle: it is an SPA
	// bundle, which isn't kept for offline here.
	HasBackend bool   `json:"hasBackend"`
	Bundle     bool   `json:"bundle"`
	Name       string `json:"name"`
	// Offline is false as served; the service worker sets it in the copy it
	// serves when the server can't be reached (publicsw.js).
	Offline bool `json:"offline"`
}

// handlePublicShell serves /s/{token} and any path below it: the shell, or
// the error about the link (404, 410).
func (s *Server) handlePublicShell(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	t, sv, err := s.st.PublicLinkPage(r.Context(), token)
	if err != nil {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Robots-Tag", "noindex, nofollow")
		publicLinkError(w, err)
		return
	}
	// The frame shows the same path and query below ~page, so a deep link
	// or a reload lands where the app was.
	src := "/s/" + token + "/~page" + strings.TrimPrefix(r.URL.EscapedPath(), "/s/"+token)
	if r.URL.RawQuery != "" {
		src += "?" + r.URL.RawQuery
	}
	var state backendState
	if t.Manifest != nil {
		state = s.backendState()
	}
	look, err := s.publicLook(r.Context(), t, sv)
	if err != nil {
		httpError(w, err)
		return
	}
	boot, _ := json.Marshal(shellBoot{
		Token: token, Version: t.Version, Backend: state, PageSrc: src,
		HasBackend: t.Manifest != nil, Bundle: sv.BundleKey != "", Name: look.Name,
	})
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", shellCSP)
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Robots-Tag", "noindex")
	h.Set("X-Content-Type-Options", "nosniff")
	// The doc's CSP for the shell has no frame-ancestors, but a public link
	// without a backend may not be framed ('none'), and a framed shell would
	// let any site drive the page's public calls from its visitors'
	// browsers (clickjacking, or racing the page's first hello by
	// navigating the inner frame). Refused here without touching the CSP.
	h.Set("X-Frame-Options", "DENY")
	// json.Marshal escapes <, > and &, so nothing in boot can close the
	// script it lands in.
	shell := strings.Replace(publicShellHTML, shellBootPlaceholder, string(boot), 1)
	// The token is the credential: the manifest needs no cookies.
	_, _ = w.Write(appShell([]byte(shell), look, "/s/"+url.PathEscape(token)+"/~app.webmanifest", false))
}

// publicLook is how a public link's app looks: as the page's signed-in app,
// from the version the link shows.
func (s *Server) publicLook(ctx context.Context, t *store.PublicTarget, sv *store.ServedVersion) (pageapp.Look, error) {
	settings, err := s.st.AppSettings(ctx, t.ID)
	if err != nil {
		return pageapp.Look{}, err
	}
	return pageapp.LookOf(t.ID, t.Title, sv.HTML, settings), nil
}

// handlePublicManifest serves a public link's app manifest. Its id and start
// are /s/{token}/; its scope, /s/{token}, covers the link as shared too.
func (s *Server) handlePublicManifest(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	t, sv, err := s.st.PublicLinkPage(r.Context(), token)
	if err != nil {
		publicLinkError(w, err)
		return
	}
	look, err := s.publicLook(r.Context(), t, sv)
	if err != nil {
		httpError(w, err)
		return
	}
	base := "/s/" + url.PathEscape(token)
	writeManifest(w, pageapp.ManifestOf(base+"/", base, look))
}

// handlePublicSW serves the public links' service worker, which keeps their
// shells for offline (publicsw.js).
func handlePublicSW(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = io.WriteString(w, publicSW)
}

// handlePublicPage serves the page in the public shell's frame, sandboxed
// onto an opaque origin, with basename /s/{token}/~page. Each load counts
// as a view, except the shell's own fetch of a copy to keep for offline
// (X-Specola-Keep: 1), which it makes besides showing the page.
func (s *Server) handlePublicPage(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	var (
		sv  *store.ServedVersion
		err error
	)
	if r.Header.Get("X-Specola-Keep") == "1" {
		_, sv, err = s.st.PublicLinkPage(r.Context(), token)
	} else {
		sv, err = s.st.OpenPublicLink(r.Context(), token)
	}
	if err != nil {
		publicLinkError(w, err)
		return
	}
	// Framed by the shell, on this same origin.
	writePage(w, s.pageHTML(sv.HTML, sv.BundleKey), "'self'", s.boot(sv, "/s/"+token+"/~page"))
}

// publicLinkError answers a link that can't be opened, as handlePublicLink
// does.
func publicLinkError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrSuperseded):
		writeSuperseded(w, "'none'", "")
	case errors.Is(err, store.ErrNotFound):
		http.Error(w, "this link doesn't exist or has been revoked", http.StatusNotFound)
	case errors.Is(err, store.ErrLinkExpired):
		http.Error(w, err.Error(), http.StatusGone)
	default:
		httpError(w, err)
	}
}

// publicTarget resolves a public link for a call or a stream, answering
// when it can't be used: 404 not-found, 410 link-expired or 410 superseded
// (a link pinned to a version that is closed now).
func (s *Server) publicTarget(w http.ResponseWriter, r *http.Request) (*store.PublicTarget, bool) {
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex")
	t, err := s.st.PublicBackendTarget(r.Context(), chi.URLParam(r, "token"))
	switch {
	case err == nil:
		return t, true
	case errors.Is(err, store.ErrNotFound):
		backendError(w, http.StatusNotFound, "not-found", "this link doesn't exist or has been revoked")
	case errors.Is(err, store.ErrLinkExpired):
		backendError(w, http.StatusGone, "link-expired", "this link has expired")
	case errors.Is(err, store.ErrSuperseded):
		backendError(w, http.StatusGone, "superseded", "this link shows a version that can't be opened any more")
	default:
		backendAccessError(w, err)
	}
	return nil, false
}

// handlePublicCall relays a call from the public shell to the page's
// backend, as an anonymous caller, for the routes the manifest declares
// public only.
func (s *Server) handlePublicCall(w http.ResponseWriter, r *http.Request) {
	t, ok := s.publicTarget(w, r)
	if !ok {
		return
	}
	version, ok := callVersion(w, r)
	if !ok {
		return
	}
	token := chi.URLParam(r, "token")
	path := strings.TrimPrefix(r.URL.EscapedPath(), "/p/"+token+"/x")
	ip := s.clientIP(r)
	var visitor *backend.Visitor
	s.callBackend(w, r, backendCall{
		page:      backend.Page{ID: t.ID, Version: t.Version, Title: t.Title},
		versionID: t.VersionID,
		codeHash:  t.CodeHash,
		manifest:  t.Manifest,
		shown:     version,
		role:      "public",
		link:      &backend.Link{ID: t.LinkID, Label: t.Label},
		limitKey:  "link\x00" + t.LinkID + "\x00" + ip,
		path:      path,
		allowed: func(w http.ResponseWriter) bool {
			if reason := publicRouteRefusal(t.Manifest.Public, r.Method, path); reason != "" {
				backendError(w, http.StatusForbidden, "not-public", reason)
				return false
			}
			if wait := s.publicLimits.allow(t.LinkID, ip, s.now()); wait > 0 {
				w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(wait.Seconds()))))
				backendError(w, http.StatusTooManyRequests, "too-many-requests",
					fmt.Sprintf("a public link takes at most %d calls a minute from one address, and %d in all", publicCallsPerIP, publicCallsPerLink))
				return false
			}
			// The caller's visitor, if it sent one: its own userDb.
			v, err := s.visitor(r, token)
			if err != nil {
				visitorError(w, err)
				return false
			}
			if v != nil {
				visitor = &backend.Visitor{ID: v.Hash}
			}
			return true
		},
		visitor: func() *backend.Visitor { return visitor },
	})
}

// publicRouteRefusal says why a call can't go through a public link, ""
// when one of the manifest's public routes ("METHOD /path", * as the last
// segment matching any rest) matches its method and path (escaped, without
// the query).
//
// The path is matched segment by segment, decoded. One a handler's URL
// parser would read differently ("." and "..", which it resolves; an
// encoded / or a \, which it may take for a separator) is refused outright,
// or /api/public/../admin would reach /api/admin.
func publicRouteRefusal(routes []string, method, path string) string {
	if path == "" {
		path = "/"
	}
	segs := strings.Split(path[1:], "/")
	for i, seg := range segs {
		dec, err := url.PathUnescape(seg)
		if err != nil || dec == "." || dec == ".." || strings.ContainsAny(dec, "/\\") {
			return `the path can't have "." or ".." segments, nor an encoded / or a \`
		}
		segs[i] = dec
	}
	for _, route := range routes {
		m, p, _ := strings.Cut(route, " ")
		if m != method {
			continue
		}
		want := strings.Split(p[1:], "/")
		last := len(want) - 1
		if want[last] == "*" {
			if len(segs) > last && slicesEqual(segs[:last], want[:last]) {
				return ""
			}
		} else if slicesEqual(segs, want) {
			return ""
		}
	}
	return fmt.Sprintf("%s %s is not one of the routes this page's backend makes public", method, path)
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// handlePublicEvents streams a backend page's pushes on public topics to
// a public-link visitor: only topics the manifest lists in topics.public,
// and never one targeted at a user.
func (s *Server) handlePublicEvents(w http.ResponseWriter, r *http.Request) {
	t, ok := s.publicTarget(w, r)
	if !ok {
		return
	}
	version, ok := streamVersion(w, r)
	if !ok {
		return
	}
	topics := streamTopics(w, r)
	if topics == nil {
		return
	}
	if version == t.Version && t.Manifest == nil {
		backendError(w, http.StatusNotFound, "no-backend", "this version of the page has no backend")
		return
	}
	if t.Manifest != nil {
		for topic := range topics {
			if !containsString(t.Manifest.Topics.Public, topic) {
				backendError(w, http.StatusForbidden, "not-public", fmt.Sprintf("topic %q is not one this page's backend makes public", topic))
				return
			}
		}
	}
	if s.runner == nil {
		backendError(w, http.StatusServiceUnavailable, "backend-disabled", "page backends are not enabled on this instance")
		return
	}
	token := chi.URLParam(r, "token")
	s.streamEvents(w, r, &subscriber{page: t.ID, version: version, topics: topics, public: true},
		version != t.Version || t.Manifest == nil, func(ctx context.Context) string {
			// Revoking or expiring the link ends its streams too.
			t, err := s.st.PublicBackendTarget(ctx, token)
			switch {
			case errors.Is(err, store.ErrSuperseded):
				return "superseded"
			case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrLinkExpired):
				return "forbidden"
			case err != nil:
				return ""
			case t.Version != version:
				return "superseded"
			}
			return ""
		})
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// peerKey holds the connection's own address in a request's context: the
// router's RealIP middleware replaces RemoteAddr with whatever
// X-Forwarded-For says, which a client sets as it likes.
const peerKey ctxKey = 1 << 8

// withPeer records the connection's address on public-link calls, before
// any middleware sees the request.
func withPeer(r *http.Request) *http.Request {
	if !strings.HasPrefix(r.URL.Path, "/p/") {
		return r
	}
	return r.WithContext(context.WithValue(r.Context(), peerKey, r.RemoteAddr))
}

// clientIP is the address the public links' rate limits count by: the
// connection's, or the first X-Forwarded-For hop when the instance is told
// to trust it (SPECOLA_TRUST_FORWARDED=1).
func (s *Server) clientIP(r *http.Request) string {
	if s.cfg.TrustForwarded {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			first, _, _ := strings.Cut(xff, ",")
			if ip := net.ParseIP(strings.TrimSpace(first)); ip != nil {
				return ip.String()
			}
		}
	}
	addr, _ := r.Context().Value(peerKey).(string)
	if addr == "" {
		addr = r.RemoteAddr
	}
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return addr
}

// rateLimiter keeps the public links' call budgets: token buckets, one per
// (link, IP) and one per link, each holding a minute's worth of calls and
// refilled continuously. Its zero value is ready to use, with the budgets of
// public calls; perIP and perLink, when set, are other budgets a minute.
type rateLimiter struct {
	perIP, perLink float64

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// allow takes one call from the link's and the (link, ip)'s budgets, both
// or neither, and returns 0; or, when either is spent, how long until it
// has a call again.
func (l *rateLimiter) allow(link, ip string, now time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buckets == nil {
		l.buckets = map[string]*bucket{}
	}
	if now.Sub(l.lastSweep) > time.Minute {
		// A full bucket is the same as none: drop it.
		for k, b := range l.buckets {
			if now.Sub(b.last) > time.Minute {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}
	keys := []string{"ip\x00" + link + "\x00" + ip, "link\x00" + link}
	caps := []float64{publicCallsPerIP, publicCallsPerLink}
	if l.perIP > 0 {
		caps[0] = l.perIP
	}
	if l.perLink > 0 {
		caps[1] = l.perLink
	}
	var wait time.Duration
	for i, k := range keys {
		b := l.buckets[k]
		if b == nil {
			b = &bucket{tokens: caps[i], last: now}
			l.buckets[k] = b
		}
		b.tokens = math.Min(caps[i], b.tokens+now.Sub(b.last).Minutes()*caps[i])
		b.last = now
		if b.tokens < 1 {
			wait = max(wait, time.Duration((1-b.tokens)/caps[i]*float64(time.Minute)))
		}
	}
	if wait > 0 {
		return wait
	}
	for _, k := range keys {
		l.buckets[k].tokens--
	}
	return 0
}
