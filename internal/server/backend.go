package server

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

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
// Not in this step: secrets (always {}), the egress proxy (a backend's
// outbound fetch is unrestricted until the runner gets it), push, cron and
// the public-link shell.

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

// isBackendCall reports whether a request path is a backend call, which is
// streamed through as it comes and so never compressed.
func isBackendCall(p string) bool {
	rest, ok := strings.CutPrefix(p, "/api/pages/")
	if !ok {
		return false
	}
	_, rest, ok = strings.Cut(rest, "/")
	return ok && (rest == "x" || strings.HasPrefix(rest, "x/"))
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

// callHeaders are the page's request headers as the handler gets them,
// sorted by name: without cookies, hop-by-hop headers, anything X-Specola-*,
// and what describes this hop rather than the page's request (Host, the
// length, the encodings this hop accepts, the trusted identity header).
func (s *Server) callHeaders(h http.Header) [][2]string {
	extra := []string{"cookie", "host", "content-length", "accept-encoding"}
	if s.cfg.TrustedUserHeader != "" {
		extra = append(extra, strings.ToLower(s.cfg.TrustedUserHeader))
	}
	var out [][2]string
	for name, values := range h {
		n := strings.ToLower(name)
		if strings.HasPrefix(n, "x-specola-") || dropped(n, h, extra...) {
			continue
		}
		for _, v := range values {
			out = append(out, [2]string{n, v})
		}
	}
	slices.SortStableFunc(out, func(a, b [2]string) int { return strings.Compare(a[0], b[0]) })
	return out
}

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
	version, err := strconv.Atoi(r.Header.Get("X-Specola-Version"))
	if err != nil || version < 1 {
		backendError(w, http.StatusBadRequest, "bad-request", "X-Specola-Version must name the version the page shows")
		return
	}
	t, err := s.st.BackendTarget(ctx, sub, id)
	if err != nil {
		backendAccessError(w, err)
		return
	}
	if version != t.Version {
		backendError(w, http.StatusConflict, "superseded", fmt.Sprintf("a new version of this page is available (version %d): reload it", t.Version))
		return
	}
	if t.Manifest == nil {
		backendError(w, http.StatusNotFound, "no-backend", "this version of the page has no backend")
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
	key := sub + "\x00" + id
	if !s.calls.acquire(key, maxCallsPerUserPage) {
		backendError(w, http.StatusTooManyRequests, "too-many-requests",
			fmt.Sprintf("at most %d requests to this page's backend can run at once", maxCallsPerUserPage))
		return
	}
	defer s.calls.release(key)

	path := strings.TrimPrefix(r.URL.EscapedPath(), "/api/pages/"+id+"/x")
	if path == "" {
		path = "/"
	}
	if r.URL.RawQuery != "" {
		path += "?" + r.URL.RawQuery
	}
	head, err := backend.EncodeInvoke(&backend.Invoke{
		Page:      backend.Page{ID: id, Version: t.Version, Title: t.Title},
		VersionID: t.VersionID,
		CodeHash:  t.CodeHash,
		User:      &t.User,
		Role:      t.Role.String(),
		// Secrets come in a later step; until then a backend gets none.
		Secrets: map[string]string{},
		Egress:  t.Manifest.Egress,
		Request: backend.Request{Method: r.Method, Path: path, Headers: s.callHeaders(r.Header)},
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
// nothing is buffered. Set-Cookie and hop-by-hop headers stay behind: the
// app origin's cookies are Specola's own.
func relayResponse(w http.ResponseWriter, res *http.Response) {
	h := w.Header()
	for name, values := range res.Header {
		n := strings.ToLower(name)
		if n == "set-cookie" || n == "content-length" || dropped(n, res.Header) {
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
	res, err := s.runner.Logs(ctx, id, since)
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
