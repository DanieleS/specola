package server

import (
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Public links show a page to anyone holding the URL, without signing in. They
// are served at /s/{token}, on the view origin when there is one, as the whole
// document: the same CSP sandbox puts the page on an opaque origin, and its
// localStorage works in memory only.

// publicLinkURL is where a public link's page is served.
func (s *Server) publicLinkURL(token string) string {
	base := s.cfg.AppBaseURL
	if s.cfg.ViewOrigin != "" {
		base = s.cfg.ViewOrigin
	}
	return base + "/s/" + token
}

// createLinkReq makes a public link. ExpiresInDays 0 (or left out) means the
// link never expires; Version 0 follows the current version.
type createLinkReq struct {
	Label         string `json:"label"`
	Version       int    `json:"version"`
	ExpiresInDays int    `json:"expiresInDays"`
}

// createdLink is a new public link with its URL, which can't be had again.
type createdLink struct {
	*store.PublicLink
	URL string `json:"url"`
}

func (s *Server) handleCreateLink(w http.ResponseWriter, r *http.Request) {
	var req createLinkReq
	if !decode(w, r, &req) {
		return
	}
	token, link, err := s.st.CreatePublicLink(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"), store.PublicLinkRequest{
		Label:   req.Label,
		Version: req.Version,
		TTL:     time.Duration(req.ExpiresInDays) * 24 * time.Hour,
	})
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, createdLink{PublicLink: link, URL: s.publicLinkURL(token)})
}

func (s *Server) handleListLinks(w http.ResponseWriter, r *http.Request) {
	links, err := s.st.PublicLinks(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, links)
}

func (s *Server) handleRevokeLink(w http.ResponseWriter, r *http.Request) {
	err := s.st.RevokePublicLink(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"), chi.URLParam(r, "link"))
	if err != nil {
		httpError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePublicLink serves the page a public link shows. Nothing is cached, so
// revoking a link takes effect at once; the token in the URL stays out of the
// page's requests and out of search engines.
func (s *Server) handlePublicLink(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Robots-Tag", "noindex, nofollow")
	html, err := s.st.OpenPublicLink(r.Context(), chi.URLParam(r, "token"))
	switch {
	case errors.Is(err, store.ErrNotFound):
		http.Error(w, "this link doesn't exist or has been revoked", http.StatusNotFound)
		return
	case errors.Is(err, store.ErrLinkExpired):
		http.Error(w, err.Error(), http.StatusGone)
		return
	case err != nil:
		httpError(w, err)
		return
	}
	writePage(w, html, "'none'")
}

// writePage sends a page's HTML, with the page SDK added, sandboxed onto an
// opaque origin; ancestors are the origins allowed to frame it.
func writePage(w http.ResponseWriter, html, ancestors string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Content-Security-Policy",
		"sandbox allow-scripts allow-popups allow-forms allow-modals; frame-ancestors "+ancestors)
	_, _ = io.WriteString(w, withSDK(html))
}
