package backend

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// Runner is the client of the backend runner: the internal API
// (docs/page-backends.md, "specola ↔ runner"), authenticated by a shared
// bearer token both ways, and the health check that says whether the runner
// is available right now.
type Runner struct {
	url, token string
	// client carries calls, whose bodies stream both ways: no overall
	// timeout, the caller's context bounds them.
	client *http.Client
	// probe carries health checks, which must answer quickly.
	probe *http.Client

	available atomic.Bool
	// version is the runner's own version, from its latest health check.
	version atomic.Value
}

// HealthEvery is how often the runner's health is checked.
const HealthEvery = 30 * time.Second

// RetryEvery is how often the health of an unavailable runner is checked.
const RetryEvery = 5 * time.Second

// headerTimeout bounds the wait for a call's response head. The runner gives
// up on a handler after 30 s without a first byte and answers
// backend-timeout itself; this is the backstop for a runner that hangs.
const headerTimeout = 60 * time.Second

// NewRunner returns a client of the runner at base (no trailing slash),
// authenticating with token. It is unavailable until its first health check
// passes.
func NewRunner(base, token string) *Runner {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	// A handler's compressed response passes through as it is; nothing is
	// decompressed (and so buffered) on the way.
	tr.DisableCompression = true
	tr.ResponseHeaderTimeout = headerTimeout
	// The runner is on a private network: the instance's outbound proxy, if
	// any, is not the way to it.
	tr.Proxy = nil
	r := &Runner{
		url: base, token: token,
		client: &http.Client{Transport: tr, CheckRedirect: noRedirects},
		probe:  &http.Client{Transport: tr, Timeout: 5 * time.Second, CheckRedirect: noRedirects},
	}
	r.version.Store("")
	return r
}

func noRedirects(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// Available reports the latest health check's result.
func (r *Runner) Available() bool { return r.available.Load() }

// Authorized reports whether an Authorization header carries the runner's
// token, comparing in constant time.
func (r *Runner) Authorized(header string) bool {
	got, ok := strings.CutPrefix(header, "Bearer ")
	return ok && subtle.ConstantTimeCompare([]byte(got), []byte(r.token)) == 1
}

// Check asks the runner's GET /health and records whether it answered
// {"ok":true}. A change of state is logged.
func (r *Runner) Check(ctx context.Context) bool {
	ok, version, err := r.health(ctx)
	if was := r.available.Swap(ok); was != ok {
		if ok {
			slog.Info("backend runner available", "url", r.url, "version", version)
		} else {
			slog.Warn("backend runner unavailable", "url", r.url, "err", err)
		}
	}
	if ok {
		r.version.Store(version)
	}
	return ok
}

func (r *Runner) health(ctx context.Context) (bool, string, error) {
	req, err := r.newRequest(ctx, http.MethodGet, "/health", nil)
	if err != nil {
		return false, "", err
	}
	res, err := r.probe.Do(req)
	if err != nil {
		return false, "", err
	}
	defer res.Body.Close()
	var h struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
	}
	if res.StatusCode != http.StatusOK {
		return false, "", &statusError{res.StatusCode}
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&h); err != nil {
		return false, "", err
	}
	return h.OK, h.Version, nil
}

type statusError struct{ code int }

func (e *statusError) Error() string { return "status " + http.StatusText(e.code) }

// Watch checks the runner's health now and every HealthEvery until ctx ends;
// every RetryEvery while it is unavailable (MarkUnavailable included), so a
// runner that restarts is back in use within seconds.
func (r *Runner) Watch(ctx context.Context) {
	t := time.NewTicker(RetryEvery)
	defer t.Stop()
	var last time.Time
	for {
		if !r.Available() || time.Since(last) >= HealthEvery {
			r.Check(ctx)
			last = time.Now()
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// MarkUnavailable records that the runner couldn't be reached, until the
// next health check says otherwise, so callers stop trying at once.
func (r *Runner) MarkUnavailable() {
	if r.available.Swap(false) {
		slog.Warn("backend runner unreachable", "url", r.url)
	}
}

// User is the caller of a backend, as the handler's ctx.user sees them.
type User struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

// Page is the page a call is for, as ctx.page.
type Page struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	Title   string `json:"title"`
}

// Link is the public link a call came through, as ctx.link.
type Link struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// Request is the head of the page's request: method, path with query, and
// headers in order.
type Request struct {
	Method  string      `json:"method"`
	Path    string      `json:"path"`
	Headers [][2]string `json:"headers"`
}

// Invoke is the head of a call to the runner, sent in X-Specola-Invoke
// (docs/page-backends.md, "Wire formats").
type Invoke struct {
	Page      Page              `json:"page"`
	VersionID string            `json:"versionId"`
	CodeHash  string            `json:"codeHash"`
	User      *User             `json:"user"`
	Role      string            `json:"role"`
	Link      *Link             `json:"link"`
	Secrets   map[string]string `json:"secrets"`
	Egress    []string          `json:"egress"`
	Request   Request           `json:"request"`
}

// MaxInvokeHeadBytes bounds the encoded X-Specola-Invoke header, so that it
// fits the runner's header limit.
const MaxInvokeHeadBytes = 48 << 10

// EncodeInvoke is the value of X-Specola-Invoke: base64url of the JSON.
func EncodeInvoke(head *Invoke) (string, error) {
	b, err := json.Marshal(head)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Invoke sends a call to the runner's POST /invoke with body (size bytes,
// or -1 when unknown) and returns its response, whose body streams. ctx
// bounds the whole call, body included; cancelling it stops the call on the
// runner too.
func (r *Runner) Invoke(ctx context.Context, encodedHead string, body io.Reader, size int64) (*http.Response, error) {
	req, err := r.newRequest(ctx, http.MethodPost, "/invoke", body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Specola-Invoke", encodedHead)
	req.Header.Set("Content-Type", "application/octet-stream")
	req.ContentLength = size
	if size == 0 {
		req.Body = http.NoBody
	}
	return r.client.Do(req)
}

// Logs asks the runner's GET /logs for a page's recent log lines after seq
// since ("" for all). The caller relays the response.
func (r *Runner) Logs(ctx context.Context, page, since string) (*http.Response, error) {
	q := url.Values{"page": {page}}
	if since != "" {
		q.Set("since", since)
	}
	req, err := r.newRequest(ctx, http.MethodGet, "/logs?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	return r.probe.Do(req)
}

func (r *Runner) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, r.url+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+r.token)
	return req, nil
}

// Unreachable reports whether err means the runner could not be reached at
// all (as opposed to a call that started and then failed).
func Unreachable(err error) bool {
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial"
}
