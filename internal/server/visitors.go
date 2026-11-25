package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Anonymous visitors of public links (docs/page-apps.md, "Anonymous
// visitors"). A visitor is one browser on one link: a random secret the
// public shell asks for (POST /p/{token}/visitor) before its first write or
// backend call, keeps in its own origin's localStorage, and sends in
// X-Specola-Visitor. No cookie: the shell's calls carry none, so a session
// on the same origin never reaches them. It keeps the page's localStorage
// (GET, PATCH, DELETE /p/{token}/data, as /api/pages/{id}/data) and, with a
// backend, its own userDb (ctx.visitor).

const (
	visitorHeader = "X-Specola-Visitor"
	// visitorIdle is how long an unused visitor is kept.
	visitorIdle = 90 * 24 * time.Hour
	// New visitors a minute, per link and client IP, and per link.
	newVisitorsPerIP   = 10
	newVisitorsPerLink = 120
)

// publicOrigin is the origin public links are served on.
func (s *Server) publicOrigin() string {
	if s.cfg.ViewOrigin != "" {
		return s.cfg.ViewOrigin
	}
	return s.cfg.AppBaseURL
}

// fromShell reports whether a request may come from the public shell: the
// same origin, by what the browser says (Sec-Fetch-Site, Origin). A page,
// on an opaque origin, says "cross-site" and Origin null.
func (s *Server) fromShell(r *http.Request) bool {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		return false
	}
	if o := r.Header.Get("Origin"); o != "" && !strings.EqualFold(o, s.publicOrigin()) {
		return false
	}
	return true
}

// visitorHash is the stored form of a visitor's secret: sha256, hex.
func visitorHash(secret string) (string, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil || len(raw) != 32 {
		return "", false
	}
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:]), true
}

// visitor is the caller's visitor on the public link token, the one its
// X-Specola-Visitor names; nil without one (none sent, or one the link
// doesn't know). An error only when the link can't be used
// (store.ErrNotFound, ErrLinkExpired, ErrSuperseded).
func (s *Server) visitor(r *http.Request, token string) (*store.Visitor, error) {
	hash, ok := visitorHash(r.Header.Get(visitorHeader))
	if !ok {
		return nil, nil
	}
	v, err := s.st.Visitor(r.Context(), token, hash)
	if errors.Is(err, store.ErrNoVisitor) {
		return nil, nil
	}
	return v, err
}

// handleNewVisitor makes a visitor on the link and answers its secret
// ({"secret"}), for the shell only (a browser saying it is on this origin),
// unless the link keeps as many visitors as it may, or gets new ones too
// fast: 429 visitor-limit, and the page's storage stays in memory.
func (s *Server) handleNewVisitor(w http.ResponseWriter, r *http.Request) {
	publicDataHeaders(w)
	token := chi.URLParam(r, "token")
	if r.Header.Get("Sec-Fetch-Site") != "same-origin" || !s.fromShell(r) {
		backendError(w, http.StatusForbidden, "not-shell", "only the link's own page makes visitors")
		return
	}
	if wait := s.visitorLimits.allow(token, s.clientIP(r), s.now()); wait > 0 {
		w.Header().Set("Retry-After", "60")
		backendError(w, http.StatusTooManyRequests, "visitor-limit", "this link gets too many new visitors right now: try again in a minute")
		return
	}
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		httpError(w, err)
		return
	}
	secret := base64.RawURLEncoding.EncodeToString(b)
	hash, _ := visitorHash(secret)
	_, err := s.st.NewVisitor(r.Context(), token, hash, s.cfg.VisitorsPerLink())
	if errors.Is(err, store.ErrVisitorLimit) {
		backendError(w, http.StatusTooManyRequests, "visitor-limit",
			"this link keeps data for as many visitors as it may: the page's storage stays in memory")
		return
	}
	if err != nil {
		visitorError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"secret": secret})
}

// visitorOf is the visitor a backend call carries, if any.
func visitorOf(c backendCall) *backend.Visitor {
	if c.visitor == nil {
		return nil
	}
	return c.visitor()
}

// visitorError answers a link that can't be used, as public calls do.
func visitorError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		backendError(w, http.StatusNotFound, "not-found", "this link doesn't exist or has been revoked")
	case errors.Is(err, store.ErrLinkExpired):
		backendError(w, http.StatusGone, "link-expired", "this link has expired")
	case errors.Is(err, store.ErrSuperseded):
		backendError(w, http.StatusGone, "superseded", "this link shows a version that can't be opened any more")
	default:
		httpError(w, err)
	}
}

func publicDataHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex")
}

// handleVisitorData answers the caller's page data on the link: {} for a
// caller with no visitor. The answer's X-Specola-Visitor says whether the
// link knows the caller's ("yes" or "none").
func (s *Server) handleVisitorData(w http.ResponseWriter, r *http.Request) {
	publicDataHeaders(w)
	token := chi.URLParam(r, "token")
	if !s.fromShell(r) {
		backendError(w, http.StatusForbidden, "not-shell", "only the link's own page can read its data")
		return
	}
	v, err := s.visitor(r, token)
	if err != nil {
		visitorError(w, err)
		return
	}
	if v == nil {
		// The link must still be usable.
		if _, err := s.st.PublicBackendTarget(r.Context(), token); err != nil {
			visitorError(w, err)
			return
		}
		w.Header().Set("X-Specola-Visitor", "none")
		writeJSON(w, http.StatusOK, map[string]string{})
		return
	}
	data, err := s.st.VisitorData(r.Context(), v)
	if err != nil {
		httpError(w, err)
		return
	}
	w.Header().Set("X-Specola-Visitor", "yes")
	writeJSON(w, http.StatusOK, data)
}

// handleUpdateVisitorData changes the caller's page data on the link, as
// PATCH /api/pages/{id}/data does (DELETE clears it). 403 no-visitor when
// the link doesn't know the caller's visitor.
func (s *Server) handleUpdateVisitorData(w http.ResponseWriter, r *http.Request) {
	publicDataHeaders(w)
	token := chi.URLParam(r, "token")
	if !s.fromShell(r) {
		backendError(w, http.StatusForbidden, "not-shell", "only the link's own page can change its data")
		return
	}
	var change store.PageDataChange
	if r.Method == http.MethodDelete {
		change.Clear = true
	} else {
		var req pageDataReq
		if !decode(w, r, &req) {
			return
		}
		change = store.PageDataChange{Clear: req.Clear, Set: req.Set, Remove: req.Remove}
	}
	v, err := s.visitor(r, token)
	if err != nil {
		visitorError(w, err)
		return
	}
	if v == nil {
		backendError(w, http.StatusForbidden, "no-visitor", "this link knows no such visitor: make one with POST /p/{token}/visitor")
		return
	}
	if err := s.st.UpdateVisitorData(r.Context(), v, change); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			visitorError(w, err)
			return
		}
		httpError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// visitorSweepEvery is how often visitors are swept.
const visitorSweepEvery = 10 * time.Minute

// SweepVisitors, every 10 minutes until ctx ends, forgets the visitors
// unused for 90 days (their page data goes with them) and deletes on the
// runner the databases of visitors gone, when it can be reached.
func (s *Server) SweepVisitors(ctx context.Context) {
	t := time.NewTicker(visitorSweepEvery)
	defer t.Stop()
	for {
		s.sweepVisitors(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (s *Server) sweepVisitors(ctx context.Context) {
	if n, err := s.st.DeleteIdleVisitors(ctx, s.now().Add(-visitorIdle)); err != nil {
		slog.Warn("sweep visitors", "err", err)
	} else if n > 0 {
		slog.Info("forgot idle public link visitors", "count", n)
	}
	for {
		gone, err := s.st.VisitorCleanups(ctx, 100)
		if err != nil {
			slog.Warn("visitor cleanup", "err", err)
			return
		}
		done := 0
		for _, g := range gone {
			if g.BackendData {
				// Wait for the runner: what it keeps of them is deleted
				// once it can be reached.
				if s.runner == nil || !s.runner.Available() {
					continue
				}
				res, err := s.runner.DeleteMyData(ctx, g.AssetID, "anon:"+g.Hash)
				if err != nil {
					if backend.Unreachable(err) {
						s.runner.MarkUnavailable()
					}
					slog.Warn("visitor cleanup: the runner", "err", err)
					return
				}
				res.Body.Close()
				// 404: nothing was kept for them.
				if res.StatusCode >= 300 && res.StatusCode != http.StatusNotFound {
					slog.Warn("visitor cleanup: the runner answered", "status", res.StatusCode)
					return
				}
			}
			if err := s.st.VisitorCleanedUp(ctx, g); err != nil {
				slog.Warn("visitor cleanup", "err", err)
				return
			}
			done++
		}
		if done == 0 || len(gone) < 100 {
			return
		}
	}
}
