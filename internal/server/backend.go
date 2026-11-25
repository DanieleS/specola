package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/danieles/specola/internal/auth"
	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Page backends (docs/page-backends.md). The viewer relays a frame's
// specola.fetch to ANY /api/pages/{id}/x/{path…} with the session cookie;
// specola checks access and the version, then forwards the call to the
// runner, which runs the page's code, and streams the answer back. The
// runner fetches the code from /internal/runner/code/{versionId}.
//
// Every /invoke and /scheduled head carries the page's declared secrets
// that are set and its egress allowlist (backendSecretsAndEgress). Push is
// in push.go, the public-link shell and its calls in publicshell.go.

const (
	// maxBackendBody bounds a call's request body.
	maxBackendBody = 25 << 20
	// maxCallsPerUserPage bounds the calls one user has running on one page.
	maxCallsPerUserPage = 8
	// maxCallTime bounds a call, streaming included.
	maxCallTime = 5 * time.Minute
)

// backendState is whether backends are configured on this instance and
// whether the runner answers right now.
type backendState struct {
	Enabled   bool `json:"enabled"`
	Available bool `json:"available"`
}

func (s *Server) backendState() backendState {
	if s.runner == nil {
		return backendState{}
	}
	return backendState{Enabled: true, Available: s.runner.Available()}
}

// backendUploadState is backendState with, when backends can't be used, why:
// told to whoever is about to publish a bundle.
type backendUploadState struct {
	backendState
	Reason string `json:"reason,omitempty"`
}

func (s *Server) backendUploadState() backendUploadState {
	st := backendUploadState{backendState: s.backendState()}
	switch {
	case !st.Enabled:
		st.Reason = "page backends are not enabled on this instance (no backend runner is configured): bundles are static"
	case !st.Available:
		st.Reason = "the backend runner is not answering right now: a bundle with a backend can be published, but its backend can't be called until the runner is back"
	}
	return st
}

// WatchRunner checks the runner's health now and every 30 seconds (every 5
// while it is down) until ctx ends. Without backends it returns at once.
func (s *Server) WatchRunner(ctx context.Context) {
	if s.runner != nil {
		s.runner.Watch(ctx)
	}
}

// backendError answers an error that specola produces about a backend call
// (as opposed to the handler's own answers): the code in X-Specola-Error and
// a JSON body (docs/page-backends.md, "Wire formats").
func backendError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("X-Specola-Error", code)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]string{"error": code, "message": message})
}

// backendAccessError answers a store error about the page of a backend call.
func backendAccessError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		backendError(w, http.StatusNotFound, "not-found", "page not found")
	case errors.Is(err, store.ErrForbidden):
		backendError(w, http.StatusForbidden, "forbidden", "you can't do that on this page")
	default:
		slog.Error("backend call", "err", err)
		backendError(w, http.StatusInternalServerError, "internal", "internal error")
	}
}

// isBackendCall reports whether a request path is a backend call or a push
// stream, which are streamed through as they come and so never compressed:
// /api/pages/{id}/x…, /api/pages/{id}/events, and their public-link
// counterparts /p/{token}/x… and /p/{token}/events.
func isBackendCall(p string) bool {
	rest, ok := strings.CutPrefix(p, "/api/pages/")
	if !ok {
		if rest, ok = strings.CutPrefix(p, "/p/"); !ok {
			return false
		}
	}
	_, rest, ok = strings.Cut(rest, "/")
	return ok && (rest == "x" || strings.HasPrefix(rest, "x/") || rest == "events")
}

// callLimiter counts the calls running per key.
type callLimiter struct {
	mu      sync.Mutex
	running map[string]int
}

func (l *callLimiter) acquire(key string, max int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.running[key] >= max {
		return false
	}
	if l.running == nil {
		l.running = map[string]int{}
	}
	l.running[key]++
	return true
}

func (l *callLimiter) release(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.running[key]--; l.running[key] <= 0 {
		delete(l.running, key)
	}
}

// hopByHop are the headers that describe one connection, not the message;
// they never cross the proxy (RFC 9110, 7.6.1).
var hopByHop = []string{"connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
	"proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"}

// dropped reports whether a header (lower-case) stays behind: hop-by-hop
// ones, those the Connection header names, and those in extra.
func dropped(name string, h http.Header, extra ...string) bool {
	if slices.Contains(hopByHop, name) || slices.Contains(extra, name) {
		return true
	}
	for _, v := range h.Values("Connection") {
		for _, n := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(n), name) {
				return true
			}
		}
	}
	return false
}

// pageHeadersHeader carries the headers the page set on its call. The
// call's own headers are not the page's: the browser adds the viewer's
// credentials to a same-origin fetch (HTTP basic auth), and a proxy in front
// of specola adds its own (an access token, the user's email…). None of
// that may reach code the page's editors write, so the viewer lists the
// page's headers here and only those are forwarded.
const pageHeadersHeader = "X-Specola-Headers"

// callHeaders are the page's request headers as the handler gets them,
// sorted by name: those the viewer listed in X-Specola-Headers (base64url
// JSON [[name, value]…]; none without it), without cookies, hop-by-hop
// headers, anything X-Specola-*, and what describes this hop rather than
// the page's request (Host, the length, the encodings this hop accepts, the
// trusted identity header).
func (s *Server) callHeaders(h http.Header) ([][2]string, error) {
	var page [][2]string
	if v := h.Get(pageHeadersHeader); v != "" {
		raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(v, "="))
		if err != nil || json.Unmarshal(raw, &page) != nil {
			return nil, errors.New(pageHeadersHeader + " must be base64url JSON [[name, value]…]")
		}
	}
	extra := []string{"cookie", "host", "content-length", "accept-encoding"}
	if s.cfg.TrustedUserHeader != "" {
		extra = append(extra, strings.ToLower(s.cfg.TrustedUserHeader))
	}
	connection := http.Header{}
	for _, kv := range page {
		if strings.EqualFold(kv[0], "connection") {
			connection.Add("Connection", kv[1])
		}
	}
	out := [][2]string{}
	for _, kv := range page {
		n := strings.ToLower(kv[0])
		if strings.HasPrefix(n, "x-specola-") || dropped(n, connection, extra...) {
			continue
		}
		out = append(out, [2]string{n, kv[1]})
	}
	slices.SortStableFunc(out, func(a, b [2]string) int { return strings.Compare(a[0], b[0]) })
	return out, nil
}

// originWide are response headers a browser applies to the whole origin they
// come from, not to the one response. A handler's answer reaches the viewer's
// fetch on specola's origin, so these would let one page's backend sign every
// viewer out (Clear-Site-Data), have their browser report every request to
// the page's author (NEL, Report-To) or change how it reaches specola. The
// runner drops the same list (runner/src/process.js, ORIGIN_WIDE).
var originWide = []string{"clear-site-data", "nel", "report-to", "reporting-endpoints",
	"strict-transport-security", "alt-svc", "accept-ch", "critical-ch", "origin-agent-cluster",
	"service-worker-allowed", "set-login", "refresh"}

// limitedBody reads a call's body and remembers whether it went over the
// limit, so that the failed call is answered 413 rather than as a runner
// error.
type limitedBody struct {
	r        io.Reader
	left     int64
	tooLarge bool
}

func (b *limitedBody) Read(p []byte) (int, error) {
	if b.left < 0 {
		b.tooLarge = true
		return 0, errors.New("request body too large")
	}
	if int64(len(p)) > b.left+1 {
		p = p[:b.left+1]
	}
	n, err := b.r.Read(p)
	b.left -= int64(n)
	if b.left < 0 {
		b.tooLarge = true
		return 0, errors.New("request body too large")
	}
	return n, err
}

// handleBackendCall relays a frame's call to its page's backend
// (docs/page-backends.md, "Viewer ↔ specola").
//
// X-Specola-Version is required: besides naming the version the frame shows,
// it is what keeps this route from being reached by anything but the
// viewer's fetch. A navigation can't send it, so a handler's HTML is never
// rendered on the app origin; and a cross-site request can't send it
// without a CORS preflight, which is never granted, so a page elsewhere
// can't call a backend with the user's cookie.
func (s *Server) handleBackendCall(w http.ResponseWriter, r *http.Request) {
	ctx, sub, id := r.Context(), subOf(r.Context()), chi.URLParam(r, "id")
	version, ok := callVersion(w, r)
	if !ok {
		return
	}
	t, err := s.st.BackendTarget(ctx, sub, id)
	if err != nil {
		backendAccessError(w, err)
		return
	}
	user := t.User
	s.callBackend(w, r, backendCall{
		page:      backend.Page{ID: t.ID, Version: t.Version, Title: t.Title},
		versionID: t.VersionID,
		codeHash:  t.CodeHash,
		manifest:  t.Manifest,
		shown:     version,
		user:      &user,
		role:      t.Role.String(),
		// t.ID, not id: one page, whatever spelling of its uuid the URL used.
		limitKey: sub + "\x00" + t.ID,
		path:     strings.TrimPrefix(r.URL.EscapedPath(), "/api/pages/"+id+"/x"),
	})
}

// callVersion reads X-Specola-Version, the version the frame shows, which a
// call must carry; it answers 400 and returns false when it doesn't.
func callVersion(w http.ResponseWriter, r *http.Request) (int, bool) {
	version, err := strconv.Atoi(r.Header.Get("X-Specola-Version"))
	if err != nil || version < 1 {
		backendError(w, http.StatusBadRequest, "bad-request", "X-Specola-Version must name the version the page shows")
		return 0, false
	}
	return version, true
}

// backendCall is one call to a page's backend, its caller already
// authorised: by the session (handleBackendCall) or a public link
// (handlePublicCall).
type backendCall struct {
	page      backend.Page // the current version
	versionID string
	codeHash  string
	manifest  *backend.Manifest // nil: the current version has no backend
	// shown is the version the frame shows (X-Specola-Version).
	shown int
	user  *backend.User
	role  string
	link  *backend.Link
	// limitKey counts the calls running for one caller on one page.
	limitKey string
	// path is the escaped path below …/x the page asked for, without the
	// query.
	path string
	// allowed, when set, is asked once the version is known to be current
	// and to have a backend, before anything is sent to the runner; it
	// answers and returns false to stop the call there.
	allowed func(w http.ResponseWriter) bool
}

// backendSecretsAndEgress are what an /invoke or /scheduled head carries
// for a page's current version, whose manifest is given: its declared
// secrets that are set, decrypted, and its egress allowlist. Both are never
// nil, so the head always has them.
func (s *Server) backendSecretsAndEgress(ctx context.Context, pageID string, manifest backend.Manifest) (map[string]string, []string, error) {
	egress := manifest.Egress
	if egress == nil {
		egress = []string{}
	}
	secrets := map[string]string{}
	if len(manifest.Secrets) == 0 {
		// Nothing declared: nothing to read.
		return secrets, egress, nil
	}
	values, err := s.st.PageSecretValues(ctx, pageID, manifest.Secrets, s.cfg.SecretsKey)
	if err != nil {
		return nil, nil, err
	}
	for _, name := range manifest.Secrets {
		if v, ok := values[name]; ok {
			secrets[name] = v
		}
	}
	return secrets, egress, nil
}

// callBackend checks a call against the current version, the runner and
// the limits, then forwards it to the runner and streams the answer back.
func (s *Server) callBackend(w http.ResponseWriter, r *http.Request, c backendCall) {
	ctx := r.Context()
	if c.shown != c.page.Version {
		backendError(w, http.StatusConflict, "superseded", fmt.Sprintf("a new version of this page is available (version %d): reload it", c.page.Version))
		return
	}
	if c.manifest == nil {
		backendError(w, http.StatusNotFound, "no-backend", "this version of the page has no backend")
		return
	}
	if c.allowed != nil && !c.allowed(w) {
		return
	}
	if s.runner == nil {
		backendError(w, http.StatusServiceUnavailable, "backend-disabled", "page backends are not enabled on this instance")
		return
	}
	if !s.runner.Available() {
		backendError(w, http.StatusServiceUnavailable, "backend-unavailable", "the backend runner is not available right now")
		return
	}
	if r.ContentLength > maxBackendBody {
		backendError(w, http.StatusRequestEntityTooLarge, "body-too-large", fmt.Sprintf("a request body can be at most %d MiB", maxBackendBody>>20))
		return
	}
	headers, err := s.callHeaders(r.Header)
	if err != nil {
		backendError(w, http.StatusBadRequest, "bad-request", err.Error())
		return
	}
	if !s.calls.acquire(c.limitKey, maxCallsPerUserPage) {
		backendError(w, http.StatusTooManyRequests, "too-many-requests",
			fmt.Sprintf("at most %d requests to this page's backend can run at once", maxCallsPerUserPage))
		return
	}
	defer s.calls.release(c.limitKey)

	path := c.path
	if path == "" {
		path = "/"
	}
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	secrets, egress, err := s.backendSecretsAndEgress(ctx, c.page.ID, *c.manifest)
	if err != nil {
		backendAccessError(w, err)
		return
	}
	head, err := backend.EncodeInvoke(&backend.Invoke{
		Page:      c.page,
		VersionID: c.versionID,
		CodeHash:  c.codeHash,
		User:      c.user,
		Role:      c.role,
		Link:      c.link,
		Secrets:   secrets,
		Egress:    egress,
		Request:   backend.Request{Method: r.Method, Path: path, Headers: headers},
	})
	if err != nil {
		backendAccessError(w, err)
		return
	}
	if len(head) > backend.MaxInvokeHeadBytes {
		backendError(w, http.StatusBadRequest, "bad-request", "the request's headers are too large")
		return
	}

	// The call ends when the frame's request does (the viewer aborts it, or
	// the user goes away), or after maxCallTime.
	callCtx, cancel := context.WithTimeout(ctx, maxCallTime)
	defer cancel()
	// The runner may answer, and its head be relayed, before the page's body
	// is all here (a handler that refuses early, or streams while it reads).
	// Over HTTP/1 Go would then cut the body still being forwarded. Only
	// now: answering a refusal without reading the body in full-duplex mode
	// trips Go's server (its background reader reads the body concurrently).
	_ = http.NewResponseController(w).EnableFullDuplex()
	body := &limitedBody{r: r.Body, left: maxBackendBody}
	size := r.ContentLength
	if r.Body == nil || r.Body == http.NoBody {
		size = 0
	}
	res, err := s.runner.Invoke(callCtx, head, body, size)
	if err != nil {
		s.callFailed(w, r, callCtx, body, err)
		return
	}
	defer res.Body.Close()
	// The handler answered (whatever its status): the page has data on the
	// runner, or may have from now on. specola's and the runner's own
	// errors don't count.
	if res.Header.Get("X-Specola-Error") == "" {
		s.markBackendUsed(ctx, c.page.ID)
	}
	relayResponse(w, res)
}

// callFailed answers a call the runner didn't answer.
func (s *Server) callFailed(w http.ResponseWriter, r *http.Request, callCtx context.Context, body *limitedBody, err error) {
	var timeout net.Error
	switch {
	case body.tooLarge:
		backendError(w, http.StatusRequestEntityTooLarge, "body-too-large", fmt.Sprintf("a request body can be at most %d MiB", maxBackendBody>>20))
	case r.Context().Err() != nil:
		// The caller went away: nobody to answer.
	case errors.Is(callCtx.Err(), context.DeadlineExceeded), errors.As(err, &timeout) && timeout.Timeout():
		backendError(w, http.StatusGatewayTimeout, "backend-timeout", "the backend took too long to answer")
	case backend.Unreachable(err):
		s.runner.MarkUnavailable()
		backendError(w, http.StatusServiceUnavailable, "backend-unavailable", "the backend runner is not available right now")
	default:
		slog.Warn("backend call failed", "err", err)
		backendError(w, http.StatusBadGateway, "backend-crashed", "the backend stopped before answering")
	}
}

// relayResponse streams the runner's response to the caller, chunk by
// chunk as it comes: a handler may stream (LLM output, long exports), so
// nothing is buffered. Set-Cookie, hop-by-hop, origin-wide and CORS headers
// stay behind: the app origin's cookies and policies are Specola's own.
func relayResponse(w http.ResponseWriter, res *http.Response) {
	h := w.Header()
	for name, values := range res.Header {
		n := strings.ToLower(name)
		if n == "set-cookie" || n == "content-length" || strings.HasPrefix(n, "access-control-") ||
			dropped(n, res.Header, originWide...) {
			continue
		}
		h[name] = values
	}
	if res.ContentLength >= 0 {
		h.Set("Content-Length", strconv.FormatInt(res.ContentLength, 10))
	}
	// The answer is for the viewer's fetch only. Should it be opened as a
	// document anyway, it is inert there.
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	if h.Get("Cache-Control") == "" {
		h.Set("Cache-Control", "private, no-store")
	}
	w.WriteHeader(res.StatusCode)

	rc := http.NewResponseController(w)
	buf := make([]byte, 32<<10)
	for {
		n, err := res.Body.Read(buf)
		if n > 0 {
			if _, werr := w.Write(buf[:n]); werr != nil {
				return
			}
			_ = rc.Flush()
		}
		if errors.Is(err, io.EOF) {
			return
		}
		if err != nil {
			// The runner stopped mid-answer: the caller must see a
			// truncated response, not a complete one.
			panic(http.ErrAbortHandler)
		}
	}
}

// handleBackendLogs relays the runner's recent log lines of a page's
// backend, to its owners and editors: they can read anything the code does
// anyway.
func (s *Server) handleBackendLogs(w http.ResponseWriter, r *http.Request) {
	ctx, id := r.Context(), chi.URLParam(r, "id")
	t, err := s.st.BackendTarget(ctx, subOf(ctx), id)
	if err != nil {
		backendAccessError(w, err)
		return
	}
	if t.Role < store.RoleEditor {
		backendError(w, http.StatusForbidden, "forbidden", "only the page's owners and editors can read its backend log")
		return
	}
	since := r.URL.Query().Get("since")
	if since != "" {
		if n, err := strconv.ParseInt(since, 10, 64); err != nil || n < 0 {
			backendError(w, http.StatusBadRequest, "bad-request", "since must be a log line's seq")
			return
		}
	}
	if s.runner == nil {
		backendError(w, http.StatusServiceUnavailable, "backend-disabled", "page backends are not enabled on this instance")
		return
	}
	res, err := s.runner.Logs(ctx, t.ID, since)
	if err != nil {
		if backend.Unreachable(err) {
			s.runner.MarkUnavailable()
		}
		backendError(w, http.StatusServiceUnavailable, "backend-unavailable", "the backend runner is not available right now")
		return
	}
	defer res.Body.Close()
	if ct := res.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	if code := res.Header.Get("X-Specola-Error"); code != "" {
		w.Header().Set("X-Specola-Error", code)
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(res.StatusCode)
	_, _ = io.Copy(w, res.Body)
}

// handleRunnerCode gives the runner a backend version's code: every file
// under .specola/, relative to it. Only the runner, with its token, may
// ask; anyone else, and everyone when backends are disabled, gets 404, as
// for a path that doesn't exist.
func (s *Server) handleRunnerCode(w http.ResponseWriter, r *http.Request) {
	if s.runner == nil || !s.runner.Authorized(r.Header.Get("Authorization")) {
		http.NotFound(w, r)
		return
	}
	hash, files, err := s.st.BackendCode(r.Context(), chi.URLParam(r, "versionId"))
	if err != nil {
		httpError(w, err)
		return
	}
	// Content is []byte: encoding/json writes it as base64.
	writeJSON(w, http.StatusOK, map[string]any{"codeHash": hash, "files": files})
}

// writeSuperseded answers a request for a version that can't be opened
// (store.ErrSuperseded) with a small page saying so, shown in the frame in
// place of the page. pageURL, when not empty, links to the page in the app.
func writeSuperseded(w http.ResponseWriter, ancestors, pageURL string) {
	h := w.Header()
	h.Del("ETag")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Specola-Error", "superseded")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors "+ancestors)
	w.WriteHeader(http.StatusGone)
	link := ""
	if pageURL != "" {
		link = ` <a href="` + html.EscapeString(pageURL) + `" target="_top">Open the current version</a>.`
	}
	_, _ = io.WriteString(w, `<!doctype html><meta charset="utf-8"><title>Version not available</title>`+
		`<style>body{font:15px/1.5 system-ui,sans-serif;margin:2rem;color:#333}</style>`+
		`<p>This page has a backend: only its current version can be opened.`+link+`</p>`)
}

// CallBackendAs calls the current version of a page's backend as sub,
// exactly as the viewer's /api/pages/{id}/x{path} would for that user
// (access, version, limits, the page's header rules) and returns the
// answer, the handler's or specola's own error (X-Specola-Error, JSON). It
// is for MCP's call_backend. path starts with / and may carry a query;
// headers are the page's own. The body streams; the caller closes it. A
// page sub can't see is the store's error (store.ErrNotFound,
// store.ErrForbidden), as BackendTarget returns it; everything after that
// is a response.
func (s *Server) CallBackendAs(ctx context.Context, sub, pageID, method, path string, headers [][2]string, body []byte) (*http.Response, error) {
	if !strings.HasPrefix(path, "/") {
		return nil, errors.New("path must start with /")
	}
	t, err := s.st.BackendTarget(ctx, sub, pageID)
	if err != nil {
		return nil, err
	}
	u, err := url.Parse("/api/pages/" + url.PathEscape(pageID) + "/x" + path)
	if err != nil {
		return nil, fmt.Errorf("bad path: %w", err)
	}
	if headers == nil {
		headers = [][2]string{}
	}
	listed, _ := json.Marshal(headers)

	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", pageID)
	ctx = context.WithValue(context.WithValue(ctx, identityKey, auth.Identity{Sub: sub}), chi.RouteCtxKey, rctx)
	// The call ends with ctx, or when the caller closes the body.
	ctx, cancel := context.WithCancel(ctx)
	req := (&http.Request{
		Method: strings.ToUpper(method), URL: u, RequestURI: u.RequestURI(),
		Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
		Header: http.Header{}, Body: http.NoBody, Host: "specola.invalid",
		RemoteAddr: "127.0.0.1:0",
	}).WithContext(ctx)
	if len(body) > 0 {
		req.Body = io.NopCloser(bytes.NewReader(body))
		req.ContentLength = int64(len(body))
	}
	for _, kv := range headers {
		req.Header.Add(kv[0], kv[1])
	}
	req.Header.Set(pageHeadersHeader, base64.RawURLEncoding.EncodeToString(listed))
	req.Header.Set("X-Specola-Version", strconv.Itoa(t.Version))

	pw := newPipeWriter(cancel)
	go func() {
		defer func() {
			// relayResponse aborts with http.ErrAbortHandler when the runner
			// stops mid-answer: the caller sees a truncated body as an
			// error, as the viewer's fetch would.
			if p := recover(); p != nil {
				pw.finish(fmt.Errorf("backend answer cut short: %v", p))
				return
			}
			pw.finish(nil)
		}()
		s.handleBackendCall(pw, req)
	}()
	select {
	case <-pw.ready:
		return pw.res, nil
	case <-ctx.Done():
		// Nobody will read the answer: let the handler's writes fail.
		_ = pw.pr.CloseWithError(ctx.Err())
		return nil, ctx.Err()
	}
}

// pipeWriter is an http.ResponseWriter whose answer is read as an
// *http.Response while the handler writes it, for CallBackendAs.
type pipeWriter struct {
	header http.Header
	res    *http.Response
	pr     *io.PipeReader
	pw     *io.PipeWriter
	once   sync.Once
	ready  chan struct{}
}

func newPipeWriter(cancel context.CancelFunc) *pipeWriter {
	pr, pw := io.Pipe()
	return &pipeWriter{header: http.Header{}, pr: pr, pw: pw, ready: make(chan struct{}),
		res: &http.Response{Body: &cancelOnClose{ReadCloser: pr, cancel: cancel}, ContentLength: -1,
			Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1}}
}

func (p *pipeWriter) Header() http.Header { return p.header }

func (p *pipeWriter) WriteHeader(status int) {
	p.once.Do(func() {
		p.res.StatusCode = status
		p.res.Status = fmt.Sprintf("%d %s", status, http.StatusText(status))
		p.res.Header = p.header.Clone()
		if n, err := strconv.ParseInt(p.header.Get("Content-Length"), 10, 64); err == nil {
			p.res.ContentLength = n
		}
		close(p.ready)
	})
}

func (p *pipeWriter) Write(b []byte) (int, error) {
	p.WriteHeader(http.StatusOK)
	return p.pw.Write(b)
}

// Flush is a no-op: every Write already reaches the reader.
func (p *pipeWriter) Flush() {}

// finish ends the answer: with err, the reader gets it instead of EOF.
func (p *pipeWriter) finish(err error) {
	p.WriteHeader(http.StatusOK)
	_ = p.pw.CloseWithError(err)
}

// cancelOnClose ends the call when its body is closed.
type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelOnClose) Close() error {
	c.cancel()
	return c.ReadCloser.Close()
}
