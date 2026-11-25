package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// A page backend's data (docs/page-backends.md, "Data lifecycle"): the
// runner keeps it, with its snapshots; specola checks who may do what and
// relays to the runner's data routes, records which pages have data, and
// purges the data of pages dormant for too long.
//
// These routes don't need the current version to have a backend: a page
// that went static keeps its data dormant, and its owners can still export,
// snapshot and wipe it. An archived page is out of reach (404) like for
// everything else; unarchiving it brings the routes back.

const (
	// maxImportBytes bounds an import's zip.
	maxImportBytes = 1 << 30
	// maxLabelChars bounds a manual snapshot's label.
	maxLabelChars = 100
	// purgeNotice is how far ahead a coming purge is told.
	purgeNotice = 7 * 24 * time.Hour
	// purgeEvery is how often dormant pages are looked for.
	purgeEvery = time.Hour
	// maxTransfersPerUserPage bounds the exports, imports and "my data"
	// downloads one user has running on one page: each holds a copy of up
	// to a page's data on the runner for as long as the browser takes (the
	// runner bounds them per page and in all too).
	maxTransfersPerUserPage = 2
	// purgeFirst is how long after start the first look is: long enough for
	// the runner's first health check, short enough that an instance
	// restarted more often than hourly still purges.
	purgeFirst = time.Minute
)

// isBackendDownload reports whether a request path is one of the data
// downloads, which are streamed through as they come and so never
// compressed (a zip and a database don't shrink anyway).
func isBackendDownload(p string) bool {
	rest, ok := strings.CutPrefix(p, "/api/pages/")
	if !ok {
		return false
	}
	_, rest, ok = strings.Cut(rest, "/")
	return ok && (rest == "backend/export" || rest == "backend/my-data")
}

// markBackendUsed records that the runner holds data for page id. It writes
// at most once an hour per page, and this process skips even asking within
// that hour. A failure is logged: the mark is kept current, not exact.
func (s *Server) markBackendUsed(ctx context.Context, id string) {
	now := s.now()
	if last, ok := s.usedMarks.Load(id); ok && now.Sub(last.(time.Time)) < store.BackendUsedEvery {
		return
	}
	// The call may end before the mark is written; the mark is still due.
	if err := s.st.MarkBackendUsed(context.WithoutCancel(ctx), id); err != nil {
		slog.Warn("record backend use", "page", id, "err", err)
		return
	}
	s.usedMarks.Store(id, now)
}

// backendPurgeAt is when the data of a page dormant since the given time
// will be purged, if that is within purgeNotice; nil when it is later, when
// the page isn't dormant, or when nothing is ever purged here.
func (s *Server) backendPurgeAt(since *time.Time) *time.Time {
	if since == nil || s.runner == nil || s.cfg.BackendPurgeAfterDays == 0 {
		return nil
	}
	at := since.Add(time.Duration(s.cfg.BackendPurgeAfterDays) * 24 * time.Hour).UTC().Truncate(time.Second)
	if at.After(s.now().Add(purgeNotice)) {
		return nil
	}
	return &at
}

// runnerReady answers backend-disabled or backend-unavailable when the
// runner can't be asked anything, and reports whether it can.
func (s *Server) runnerReady(w http.ResponseWriter) bool {
	switch {
	case s.runner == nil:
		backendError(w, http.StatusServiceUnavailable, "backend-disabled", "page backends are not enabled on this instance")
	case !s.runner.Available():
		backendError(w, http.StatusServiceUnavailable, "backend-unavailable", "the backend runner is not available right now")
	default:
		return true
	}
	return false
}

// dataTarget resolves the page of a data route: one the caller can view
// (404 otherwise), on which they have at least role min (403 forbidden,
// saying who may), with a runner to ask.
func (s *Server) dataTarget(w http.ResponseWriter, r *http.Request, min store.Role, who string) (*store.BackendTarget, bool) {
	ctx := r.Context()
	t, err := s.st.BackendTarget(ctx, subOf(ctx), chi.URLParam(r, "id"))
	if err != nil {
		backendAccessError(w, err)
		return nil, false
	}
	if t.Role < min {
		backendError(w, http.StatusForbidden, "forbidden", "only the page's "+who+" can do that with its backend data")
		return nil, false
	}
	if !s.runnerReady(w) {
		return nil, false
	}
	return t, true
}

// decodeData reads a data route's small JSON body; a bad one is answered
// 400 bad-request.
func decodeData(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(dst); err != nil {
		backendError(w, http.StatusBadRequest, "bad-request", "the body must be JSON")
		return false
	}
	return true
}

// dataFailed answers a data request the runner didn't answer. tooLarge: the
// caller's body went over its limit, which is what stopped the request.
func (s *Server) dataFailed(w http.ResponseWriter, r *http.Request, err error, tooLarge bool, limit string) {
	var timeout net.Error
	switch {
	case tooLarge:
		backendError(w, http.StatusRequestEntityTooLarge, "body-too-large", "the body can be at most "+limit)
	case r.Context().Err() != nil:
		// The caller went away: nobody to answer.
	case backend.Unreachable(err):
		s.runner.MarkUnavailable()
		backendError(w, http.StatusServiceUnavailable, "backend-unavailable", "the backend runner is not available right now")
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &timeout) && timeout.Timeout():
		backendError(w, http.StatusGatewayTimeout, "backend-timeout", "the backend runner took too long to answer")
	default:
		slog.Warn("backend data request failed", "err", err)
		backendError(w, http.StatusBadGateway, "backend-crashed", "the backend runner stopped before answering")
	}
}

// relayData answers with the runner's answer to a data request, its body
// streamed as it comes. The runner's own errors (X-Specola-Error) pass
// through; a failure without a code breaks the contract and is answered
// as the runner failing. download, if set, describes a successful answer's
// body (type and file name), which is specola's to say.
func relayData(w http.ResponseWriter, res *http.Response, download func(http.Header)) {
	defer res.Body.Close()
	code := res.Header.Get("X-Specola-Error")
	if res.StatusCode >= 400 && code == "" {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<10))
		slog.Warn("backend runner failed", "status", res.StatusCode, "body", string(b))
		backendError(w, http.StatusBadGateway, "backend-crashed", "the backend runner failed ("+res.Status+")")
		return
	}
	h := w.Header()
	if ct := res.Header.Get("Content-Type"); ct != "" {
		h.Set("Content-Type", ct)
	}
	if code != "" {
		h.Set("X-Specola-Error", code)
	}
	if res.StatusCode < 300 && download != nil {
		download(h)
	}
	if res.ContentLength >= 0 {
		h.Set("Content-Length", strconv.FormatInt(res.ContentLength, 10))
	}
	h.Set("Cache-Control", "private, no-store")
	h.Set("X-Content-Type-Options", "nosniff")
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
			// Cut short: the caller must not get half a zip as a whole one.
			panic(http.ErrAbortHandler)
		}
	}
}

// asAttachment describes a download of type contentType saved as name.
func asAttachment(contentType, name string) func(http.Header) {
	return func(h http.Header) {
		h.Set("Content-Type", contentType)
		h.Set("Content-Disposition", attachment(name))
	}
}

// attachment is a Content-Disposition saving the body as name, whatever
// characters the page's title has (non-ASCII ones go in filename*).
func attachment(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || strings.ContainsRune(`/\"`, r) {
			return '_'
		}
		return r
	}, name)
	if v := mime.FormatMediaType("attachment", map[string]string{"filename": name}); v != "" {
		return v
	}
	return "attachment"
}

// fileTitle is a page's title as the start of a file name.
func fileTitle(t *store.BackendTarget) string {
	if s := strings.TrimSpace(t.Title); s != "" {
		return s
	}
	return "page"
}

// acquireTransfer counts a data transfer of the caller's on the page, or
// answers 429 too-many-requests when they have too many running already.
// Counted apart from calls (a long download doesn't hold back the app).
func (s *Server) acquireTransfer(w http.ResponseWriter, t *store.BackendTarget) bool {
	if s.calls.acquire(transferKey(t), maxTransfersPerUserPage) {
		return true
	}
	backendError(w, http.StatusTooManyRequests, "too-many-requests",
		fmt.Sprintf("at most %d exports, imports or downloads of this page's data can run at once", maxTransfersPerUserPage))
	return false
}

func (s *Server) releaseTransfer(t *store.BackendTarget) { s.calls.release(transferKey(t)) }

func transferKey(t *store.BackendTarget) string { return "data\x00" + t.User.Sub + "\x00" + t.ID }

// handleBackendDataInfo answers the page's data usage and its snapshots,
// to its owners and editors.
func (s *Server) handleBackendDataInfo(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleEditor, "owners and editors")
	if !ok {
		return
	}
	res, err := s.runner.DataUsage(r.Context(), t.ID)
	if err != nil {
		s.dataFailed(w, r, err, false, "")
		return
	}
	relayData(w, res, nil)
}

// handleCreateSnapshot takes a manual snapshot, with a label, for an owner.
func (s *Server) handleCreateSnapshot(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleOwner, "owners")
	if !ok {
		return
	}
	var req struct {
		Label string `json:"label"`
	}
	if !decodeData(w, r, &req) {
		return
	}
	label := strings.TrimSpace(req.Label)
	if n := utf8.RuneCountInString(label); n < 1 || n > maxLabelChars {
		backendError(w, http.StatusBadRequest, "bad-request", fmt.Sprintf("a snapshot's label is 1 to %d characters", maxLabelChars))
		return
	}
	res, err := s.runner.CreateSnapshot(r.Context(), t.ID, label)
	if err != nil {
		s.dataFailed(w, r, err, false, "")
		return
	}
	relayData(w, res, nil)
}

// snapshotID is the {sid} of a snapshot route, or "" after answering 404
// when it can't name a snapshot.
func snapshotID(w http.ResponseWriter, r *http.Request) string {
	sid := chi.URLParam(r, "sid")
	if !backend.SnapshotID.MatchString(sid) {
		backendError(w, http.StatusNotFound, "not-found", "no such snapshot")
		return ""
	}
	return sid
}

// handleDeleteSnapshot deletes a manual snapshot, for an owner (the runner
// refuses the automatic ones: not-manual).
func (s *Server) handleDeleteSnapshot(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleOwner, "owners")
	if !ok {
		return
	}
	sid := snapshotID(w, r)
	if sid == "" {
		return
	}
	res, err := s.runner.DeleteSnapshot(r.Context(), t.ID, sid)
	if err != nil {
		s.dataFailed(w, r, err, false, "")
		return
	}
	relayData(w, res, nil)
}

// handleRestoreSnapshot replaces all of the page's data with a snapshot, for
// an owner; the runner takes a snapshot first, which is the answer.
func (s *Server) handleRestoreSnapshot(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleOwner, "owners")
	if !ok {
		return
	}
	sid := snapshotID(w, r)
	if sid == "" {
		return
	}
	res, err := s.runner.RestoreSnapshot(r.Context(), t.ID, sid, t.Version)
	if err != nil {
		s.dataFailed(w, r, err, false, "")
		return
	}
	if res.StatusCode < 300 {
		// The page has data again, whatever it had before.
		s.markBackendUsed(r.Context(), t.ID)
	}
	relayData(w, res, nil)
}

// handleBackendExport streams the page's shared data and files as a zip, to
// its owners and editors (who can read all of it through code anyway).
func (s *Server) handleBackendExport(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleEditor, "owners and editors")
	if !ok {
		return
	}
	if !s.acquireTransfer(w, t) {
		return
	}
	defer s.releaseTransfer(t)
	res, err := s.runner.Export(r.Context(), t.ID, t.Title, t.Version)
	if err != nil {
		s.dataFailed(w, r, err, false, "")
		return
	}
	relayData(w, res, asAttachment("application/zip", fileTitle(t)+"-data.zip"))
}

// importTypes are the types a zip comes as: its own, and the one Windows
// gives a .zip file picked in a browser.
var importTypes = []string{"application/zip", "application/x-zip-compressed"}

// handleBackendImport replaces the page's shared data and files with a zip
// in the export format, for an owner. The zip streams through to the
// runner, which checks it whole before changing anything (bad-import).
func (s *Server) handleBackendImport(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleOwner, "owners")
	if !ok {
		return
	}
	mt, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if !slices.Contains(importTypes, mt) {
		backendError(w, http.StatusBadRequest, "bad-import", "send the zip as the request body, with Content-Type: application/zip")
		return
	}
	const limit = "1 GiB"
	if r.ContentLength > maxImportBytes {
		backendError(w, http.StatusRequestEntityTooLarge, "body-too-large", "the body can be at most "+limit)
		return
	}
	// The runner may refuse before the whole zip is here; its answer must
	// still reach the caller. Only now: a handler that answers without
	// reading the body in full-duplex mode trips Go's server (a concurrent
	// read of the body by its background reader).
	_ = http.NewResponseController(w).EnableFullDuplex()
	if !s.acquireTransfer(w, t) {
		return
	}
	defer s.releaseTransfer(t)
	body := &limitedBody{r: r.Body, left: maxImportBytes}
	size := r.ContentLength
	if r.Body == nil || r.Body == http.NoBody {
		size = 0
	}
	res, err := s.runner.Import(r.Context(), t.ID, body, size)
	if err != nil {
		s.dataFailed(w, r, err, body.tooLarge, limit)
		return
	}
	if res.StatusCode < 300 {
		s.markBackendUsed(r.Context(), t.ID)
	}
	relayData(w, res, nil)
}

// handleBackendWipe resets the page's shared data and files, or every
// user's own data, for an owner; the runner takes a snapshot first.
func (s *Server) handleBackendWipe(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleOwner, "owners")
	if !ok {
		return
	}
	var req struct {
		Scope string `json:"scope"`
	}
	if !decodeData(w, r, &req) {
		return
	}
	if req.Scope != "shared" && req.Scope != "users" {
		backendError(w, http.StatusBadRequest, "bad-request", `scope must be "shared" or "users"`)
		return
	}
	res, err := s.runner.Wipe(r.Context(), t.ID, req.Scope)
	if err != nil {
		s.dataFailed(w, r, err, false, "")
		return
	}
	relayData(w, res, nil)
}

// handleMyData streams the caller's own database on the page (userDb), to
// any viewer: it is theirs. 404 no-data when they have none.
func (s *Server) handleMyData(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleViewer, "viewers")
	if !ok {
		return
	}
	if !s.acquireTransfer(w, t) {
		return
	}
	defer s.releaseTransfer(t)
	res, err := s.runner.MyData(r.Context(), t.ID, t.User.Sub)
	if err != nil {
		s.dataFailed(w, r, err, false, "")
		return
	}
	relayData(w, res, asAttachment("application/vnd.sqlite3", fileTitle(t)+"-my-data.sqlite"))
}

// handleDeleteMyData deletes the caller's own database on the page, with no
// snapshot: it is theirs to delete.
func (s *Server) handleDeleteMyData(w http.ResponseWriter, r *http.Request) {
	t, ok := s.dataTarget(w, r, store.RoleViewer, "viewers")
	if !ok {
		return
	}
	res, err := s.runner.DeleteMyData(r.Context(), t.ID, t.User.Sub)
	if err != nil {
		s.dataFailed(w, r, err, false, "")
		return
	}
	relayData(w, res, nil)
}

// PurgeBackends deletes, about every hour until ctx ends, the backend data
// of pages dormant for longer than SPECOLA_BACKEND_PURGE_AFTER_DAYS. It
// returns at once when that is unset or backends are disabled.
func (s *Server) PurgeBackends(ctx context.Context) {
	if s.runner == nil || s.cfg.BackendPurgeAfterDays == 0 {
		return
	}
	t := time.NewTimer(min(purgeFirst, s.purgeEvery))
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		s.purgeDormant(ctx)
		t.Reset(s.purgeEvery)
	}
}

// purgeDormant purges what is due now and returns how many pages it purged.
// Nothing happens while the runner is unavailable, and a page whose purge
// fails keeps its data and mark: both wait for the next round.
func (s *Server) purgeDormant(ctx context.Context) int {
	if !s.runner.Available() {
		slog.Info("backend purge skipped: the runner is not available")
		return 0
	}
	days := s.cfg.BackendPurgeAfterDays
	before := s.now().Add(-time.Duration(days) * 24 * time.Hour)
	ids, err := s.st.BackendPurgeDue(ctx, before)
	if err != nil {
		slog.Warn("backend purge", "err", err)
		return 0
	}
	n := 0
	for _, id := range ids {
		ran, err := s.st.PurgeBackendData(ctx, id, before, func(ctx context.Context) error {
			err := s.runner.Purge(ctx, id)
			if backend.Unreachable(err) {
				s.runner.MarkUnavailable()
			}
			return err
		})
		if err != nil {
			slog.Warn("backend purge failed; retrying next round", "page", id, "err", err)
			if !s.runner.Available() {
				return n
			}
			continue
		}
		if ran {
			s.usedMarks.Delete(id)
			slog.Info("purged the backend data of a dormant page", "page", id, "afterDays", days)
			n++
		}
	}
	return n
}
