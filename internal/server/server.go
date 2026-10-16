// Package server wires the HTTP surface: OIDC auth routes, the JSON API, the
// sandboxed page viewer, and the embedded SPA.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/danieles/specola/internal/auth"
	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/webui"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

type ctxKey int

const emailKey ctxKey = iota

type Server struct {
	cfg  *config.Config
	st   *store.Store
	auth *auth.Auth // nil in dev-bypass mode
	mux  http.Handler
}

func New(cfg *config.Config, st *store.Store, a *auth.Auth) *Server {
	s := &Server{cfg: cfg, st: st, auth: a}

	r := chi.NewRouter()
	r.Use(middleware.RequestID, middleware.RealIP, middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})

	if a != nil {
		r.Get("/auth/login", a.Login)
		r.Get("/auth/callback", a.Callback)
		r.Get("/auth/logout", a.Logout)
	}

	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Get("/view/{id}", s.handleView)
		r.Route("/api", func(r chi.Router) {
			r.Get("/me", s.handleMe)
			r.Get("/tree", s.handleTree)
			r.Post("/folders", s.handleCreateFolder)
			r.Post("/pages", s.handleCreatePage)
			r.Get("/pages/{id}", s.handlePageMeta)
			r.Post("/pages/{id}/versions", s.handleAddVersion)
		})
	})

	// Everything else is the SPA (public shell; data endpoints above are gated).
	r.Handle("/*", webui.Handler())

	s.mux = r
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// requireAuth resolves the caller's email (OIDC session, or the dev bypass) and
// stashes it in the request context.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		email := s.cfg.DevAuthEmail
		if s.auth != nil {
			email = s.auth.Email(r)
		}
		if email == "" {
			if strings.HasPrefix(r.URL.Path, "/api") {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			http.Redirect(w, r, "/auth/login", http.StatusFound)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), emailKey, email)))
	})
}

func emailOf(ctx context.Context) string {
	v, _ := ctx.Value(emailKey).(string)
	return v
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"email": emailOf(r.Context())})
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	var parent *string
	if p := strings.TrimSpace(r.URL.Query().Get("parent")); p != "" {
		parent = &p
	}
	items, err := s.st.Tree(r.Context(), parent)
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

type createFolderReq struct {
	Name     string  `json:"name"`
	ParentID *string `json:"parentId"`
}

func (s *Server) handleCreateFolder(w http.ResponseWriter, r *http.Request) {
	var req createFolderReq
	if !decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	id, err := s.st.CreateFolder(r.Context(), req.ParentID, req.Name, emailOf(r.Context()))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

type createPageReq struct {
	Name     string  `json:"name"`
	HTML     string  `json:"html"`
	FolderID *string `json:"folderId"`
}

func (s *Server) handleCreatePage(w http.ResponseWriter, r *http.Request) {
	var req createPageReq
	if !decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Name) == "" || req.HTML == "" {
		http.Error(w, "name and html are required", http.StatusBadRequest)
		return
	}
	id, version, err := s.st.CreatePage(r.Context(), req.FolderID, req.Name, req.HTML, emailOf(r.Context()))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "version": version})
}

type addVersionReq struct {
	HTML string `json:"html"`
}

func (s *Server) handleAddVersion(w http.ResponseWriter, r *http.Request) {
	var req addVersionReq
	if !decode(w, r, &req) {
		return
	}
	if req.HTML == "" {
		http.Error(w, "html is required", http.StatusBadRequest)
		return
	}
	version, err := s.st.AddVersion(r.Context(), chi.URLParam(r, "id"), req.HTML, emailOf(r.Context()))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int{"version": version})
}

func (s *Server) handlePageMeta(w http.ResponseWriter, r *http.Request) {
	meta, err := s.st.PageMeta(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

// handleView serves a page's stored HTML. The CSP sandbox puts the page on an
// opaque origin so its scripts cannot read Specola's cookies or call its API.
func (s *Server) handleView(w http.ResponseWriter, r *http.Request) {
	html, err := s.st.CurrentContent(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-forms allow-modals")
	_, _ = io.WriteString(w, html)
}

func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<20)).Decode(dst); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	http.Error(w, "internal error", http.StatusInternalServerError)
}
