package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"
)

// The runner's data routes (docs/page-backends.md, "Wire formats for data"):
// snapshots, export, import, wipe, a user's own data and the purge. specola
// has checked access already; the page id is the canonical one.
//
// Each method returns the runner's response as it is, for the caller to
// relay: its bodies are the API's (JSON, or a stream for the downloads),
// and its errors carry X-Specola-Error like any other. The response's body
// must be closed; closing it also releases the call's deadline.

// Deadlines per kind of call. A query or a deletion is quick. A snapshot, a
// restore or a wipe copies or removes every database of the page (up to the
// page's 1 GiB and more) and takes the page offline while it runs. Export,
// import and a user's own data move up to a GiB over the network, at the pace
// of the browser on the other end.
const (
	quickCall    = 30 * time.Second
	workCall     = 10 * time.Minute
	transferCall = 2 * time.Hour
)

// SnapshotID is the shape of a snapshot's id: <UTC stamp>-<kind>, and -v<N>
// for a version snapshot.
var SnapshotID = regexp.MustCompile(`^[0-9]{8}T[0-9]{6}Z-[a-z-]+(-v[0-9]+)?$`)

// DataUsage asks GET /pages/{id}/data: {usage, snapshots}.
func (r *Runner) DataUsage(ctx context.Context, page string) (*http.Response, error) {
	return r.data(ctx, quickCall, http.MethodGet, "/pages/"+url.PathEscape(page)+"/data", nil, 0, "", nil)
}

// CreateSnapshot asks POST /pages/{id}/snapshots for a manual snapshot.
func (r *Runner) CreateSnapshot(ctx context.Context, page, label string) (*http.Response, error) {
	return r.dataJSON(ctx, workCall, http.MethodPost, "/pages/"+url.PathEscape(page)+"/snapshots",
		map[string]string{"kind": "manual", "label": label})
}

// DeleteSnapshot asks DELETE /pages/{id}/snapshots/{sid}. The runner waits
// for any snapshot, restore, import or wipe of the page under way first.
func (r *Runner) DeleteSnapshot(ctx context.Context, page, sid string) (*http.Response, error) {
	return r.data(ctx, workCall, http.MethodDelete, "/pages/"+url.PathEscape(page)+"/snapshots/"+url.PathEscape(sid), nil, 0, "", nil)
}

// RestoreSnapshot asks POST /pages/{id}/snapshots/{sid}/restore: {before}.
// current is the page's current version, in X-Specola-Version: when the
// runner has not run it yet (a version just restored with its data), the
// data is restored for it, and the version it replaces neither runs again
// nor takes that data for its own.
func (r *Runner) RestoreSnapshot(ctx context.Context, page, sid string, current int) (*http.Response, error) {
	return r.data(ctx, workCall, http.MethodPost, "/pages/"+url.PathEscape(page)+"/snapshots/"+url.PathEscape(sid)+"/restore", nil, 0, "",
		http.Header{"X-Specola-Version": {strconv.Itoa(current)}})
}

// Export asks GET /pages/{id}/export: the zip, streamed. title and version
// are the page's as specola has them, for the zip's manifest.
func (r *Runner) Export(ctx context.Context, page, title string, version int) (*http.Response, error) {
	q := url.Values{"title": {title}, "version": {strconv.Itoa(version)}}
	return r.data(ctx, transferCall, http.MethodGet, "/pages/"+url.PathEscape(page)+"/export?"+q.Encode(), nil, 0, "", nil)
}

// Import sends a zip (size bytes, -1 when unknown) to PUT /pages/{id}/import,
// streaming body as it is read: {before}.
func (r *Runner) Import(ctx context.Context, page string, body io.Reader, size int64) (*http.Response, error) {
	return r.data(ctx, transferCall, http.MethodPut, "/pages/"+url.PathEscape(page)+"/import", body, size, "",
		http.Header{"Content-Type": {"application/zip"}})
}

// Wipe asks POST /pages/{id}/wipe for scope "shared" or "users": {before}.
func (r *Runner) Wipe(ctx context.Context, page, scope string) (*http.Response, error) {
	return r.dataJSON(ctx, workCall, http.MethodPost, "/pages/"+url.PathEscape(page)+"/wipe", map[string]string{"scope": scope})
}

// MyData asks GET /pages/{id}/my-data for sub's own database, streamed.
func (r *Runner) MyData(ctx context.Context, page, sub string) (*http.Response, error) {
	return r.data(ctx, transferCall, http.MethodGet, "/pages/"+url.PathEscape(page)+"/my-data", nil, 0, sub, nil)
}

// DeleteMyData asks DELETE /pages/{id}/my-data for sub's own database. It is
// quick itself, but the runner runs it after any restore, import or wipe of
// the page already under way, so it gets their deadline.
func (r *Runner) DeleteMyData(ctx context.Context, page, sub string) (*http.Response, error) {
	return r.data(ctx, workCall, http.MethodDelete, "/pages/"+url.PathEscape(page)+"/my-data", nil, 0, sub, nil)
}

// Purge asks DELETE /pages/{id}: everything of the page goes, its snapshots
// too. Only a 204 is success.
func (r *Runner) Purge(ctx context.Context, page string) error {
	res, err := r.data(ctx, workCall, http.MethodDelete, "/pages/"+url.PathEscape(page), nil, 0, "", nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<10))
		return fmt.Errorf("runner purge: %s: %s", res.Status, bytes.TrimSpace(b))
	}
	return nil
}

func (r *Runner) dataJSON(ctx context.Context, timeout time.Duration, method, path string, v any) (*http.Response, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return r.data(ctx, timeout, method, path, bytes.NewReader(b), int64(len(b)), "",
		http.Header{"Content-Type": {"application/json"}})
}

// data sends one data request, bounded by timeout from now (and by ctx).
// sub, when not empty, is the caller whose own data it is about, in
// X-Specola-Sub.
func (r *Runner) data(ctx context.Context, timeout time.Duration, method, path string, body io.Reader, size int64, sub string, h http.Header) (*http.Response, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	req, err := r.newRequest(ctx, method, path, body)
	if err != nil {
		cancel()
		return nil, err
	}
	for k, v := range h {
		req.Header[k] = v
	}
	if sub != "" {
		req.Header.Set("X-Specola-Sub", sub)
	}
	req.ContentLength = size
	if body == nil || size == 0 {
		req.Body = http.NoBody
	}
	res, err := r.slow.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	res.Body = &cancelOnClose{ReadCloser: res.Body, cancel: cancel}
	return res, nil
}

// cancelOnClose releases a call's deadline when its body is closed.
type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}
