// Package server wires the HTTP surface: OIDC auth routes, the JSON API, the
// sandboxed page viewer, and the embedded SPA.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/danieles/specola/internal/auth"
	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/mcpserver"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/webui"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	mcpauth "github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/oauthex"
)

type ctxKey int

const identityKey ctxKey = iota

type Server struct {
	cfg  *config.Config
	st   *store.Store
	auth *auth.Auth // nil in trusted-header and dev-bypass modes
	mux  http.Handler

	// seen holds the subs already recorded in app_user by this process, for the
	// modes that have no login step to hook (trusted header, dev bypass).
	seen sync.Map
}

// New builds the server. a is nil unless Specola runs its own OIDC login.
// tokens verifies MCP access tokens and is required when cfg.MCPMode() is
// "oauth"; it is ignored otherwise.
func New(cfg *config.Config, st *store.Store, a *auth.Auth, tokens mcpauth.TokenVerifier) *Server {
	s := &Server{cfg: cfg, st: st, auth: a}
	if a != nil {
		a.OnLogin = func(ctx context.Context, id auth.Identity, name string) error {
			return st.UpsertUser(ctx, id.Sub, id.Email, name)
		}
	}

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

	s.mountMCP(r, tokens)

	// The token is the credential: no session needed, so agents can curl it.
	r.Put("/upload/{token}", s.handleUpload)

	r.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		r.Get("/view/{id}", s.handleView)
		r.Route("/api", func(r chi.Router) {
			r.Get("/me", s.handleMe)
			r.Get("/tree", s.handleTree)
			r.Post("/folders", s.handleCreateFolder)
			r.Post("/pages", s.handleCreatePage)
			r.Get("/pages/{id}", s.handlePageMeta)
			r.Get("/pages/{id}/versions", s.handleVersions)
			r.Post("/pages/{id}/versions", s.handleAddVersion)
			r.Get("/shared", s.handleShared)
			r.Get("/archived", s.handleArchived)
			r.Get("/search", s.handleSearch)
			for _, k := range []string{"pages", "folders"} {
				r.Patch("/"+k+"/{id}", s.handleUpdateItem)
				r.Post("/"+k+"/{id}/archive", s.handleArchive)
				r.Post("/"+k+"/{id}/unarchive", s.handleUnarchive)
				r.Get("/"+k+"/{id}/acl", s.handleListShares)
				r.Put("/"+k+"/{id}/acl", s.handleShare)
				r.Delete("/"+k+"/{id}/acl", s.handleUnshare)
			}
		})
	})

	// Everything else is the SPA (public shell; data endpoints above are gated).
	r.Handle("/*", webui.Handler())

	s.mux = r
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

// requireAuth resolves the caller's identity (OIDC session, trusted proxy
// header, or the dev bypass) and stashes it in the request context.
func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var id auth.Identity
		switch {
		case s.cfg.TrustedUserHeader != "":
			// The header value is the subject. Proxies commonly send an email
			// there, so use it as the email too when it looks like one.
			id.Sub = strings.TrimSpace(r.Header.Get(s.cfg.TrustedUserHeader))
			if strings.Contains(id.Sub, "@") {
				id.Email = id.Sub
			}
			s.recordUser(r.Context(), id)
		case s.auth != nil:
			id = s.auth.Identity(r)
		default:
			id = auth.Identity{Sub: s.cfg.DevAuthEmail, Email: s.cfg.DevAuthEmail}
			s.recordUser(r.Context(), id)
		}
		if id.Sub == "" {
			// Only our own OIDC flow can recover an anonymous browser request.
			if s.auth != nil && !strings.HasPrefix(r.URL.Path, "/api") {
				http.Redirect(w, r, "/auth/login", http.StatusFound)
				return
			}
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityKey, id)))
	})
}

// mountMCP serves the MCP endpoint at /mcp according to cfg.MCPMode().
func (s *Server) mountMCP(r chi.Router, tokens mcpauth.TokenVerifier) {
	opts := mcpserver.Options{
		BaseURL: s.cfg.AppBaseURL,
		OnUser:  s.recordUser,
	}
	switch s.cfg.MCPMode() {
	case "oauth":
		// RFC 9728 metadata, at the root and at the path-suffixed location
		// clients derive from the resource URL.
		metaURL := s.cfg.AppBaseURL + "/.well-known/oauth-protected-resource"
		meta := mcpauth.ProtectedResourceMetadataHandler(&oauthex.ProtectedResourceMetadata{
			Resource:               s.cfg.MCPResource,
			AuthorizationServers:   []string{s.cfg.OIDCIssuer},
			BearerMethodsSupported: []string{"header"},
			ResourceName:           "Specola",
		})
		r.Handle("/.well-known/oauth-protected-resource", meta)
		r.Handle("/.well-known/oauth-protected-resource/mcp", meta)
		bearer := mcpauth.RequireBearerToken(tokens, &mcpauth.RequireBearerTokenOptions{
			ResourceMetadataURL: metaURL,
			ClockSkew:           time.Minute,
		})
		r.Handle("/mcp", bearer(mcpserver.Handler(s.st, opts)))
	case "dev":
		// No tokens locally: every request acts as the dev user.
		opts.LocalhostProtection = true
		dev := &mcpauth.TokenInfo{UserID: s.cfg.DevAuthEmail, Extra: map[string]any{"email": s.cfg.DevAuthEmail}}
		verify := mcpauth.RequireBearerToken(func(context.Context, string, *http.Request) (*mcpauth.TokenInfo, error) {
			ti := *dev
			ti.Expiration = time.Now().Add(time.Hour)
			return &ti, nil
		}, nil)
		h := verify(mcpserver.Handler(s.st, opts))
		r.Handle("/mcp", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Header.Set("Authorization", "Bearer dev")
			h.ServeHTTP(w, r)
		}))
	}
}

// recordUser upserts app_user the first time this process sees a sub. A failure
// is logged and retried on the next request rather than failing this one.
func (s *Server) recordUser(ctx context.Context, id auth.Identity) {
	if id.Sub == "" {
		return
	}
	if _, done := s.seen.Load(id.Sub); done {
		return
	}
	if err := s.st.UpsertUser(ctx, id.Sub, id.Email, ""); err != nil {
		slog.Warn("record user", "err", err)
		return
	}
	s.seen.Store(id.Sub, struct{}{})
}

func identityOf(ctx context.Context) auth.Identity {
	v, _ := ctx.Value(identityKey).(auth.Identity)
	return v
}

func subOf(ctx context.Context) string { return identityOf(ctx).Sub }

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, identityOf(r.Context()))
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	var parent *string
	if p := strings.TrimSpace(r.URL.Query().Get("parent")); p != "" {
		parent = &p
	}
	items, err := s.st.Tree(r.Context(), subOf(r.Context()), parent)
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
	id, err := s.st.CreateFolder(r.Context(), req.ParentID, req.Name, subOf(r.Context()))
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
	id, version, err := s.st.CreatePage(r.Context(), req.FolderID, req.Name, req.HTML, subOf(r.Context()))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "version": version})
}

// addVersionReq carries either new HTML or the number of an earlier version to
// restore as the new one.
type addVersionReq struct {
	HTML        string `json:"html"`
	RestoreFrom int    `json:"restoreFrom"`
}

func (s *Server) handleAddVersion(w http.ResponseWriter, r *http.Request) {
	var req addVersionReq
	if !decode(w, r, &req) {
		return
	}
	if (req.HTML == "") == (req.RestoreFrom == 0) {
		http.Error(w, "send either html or restoreFrom", http.StatusBadRequest)
		return
	}
	var (
		version int
		err     error
	)
	if req.RestoreFrom != 0 {
		version, err = s.st.RestoreVersion(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"), req.RestoreFrom)
	} else {
		version, err = s.st.AddVersion(r.Context(), chi.URLParam(r, "id"), req.HTML, subOf(r.Context()))
	}
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]int{"version": version})
}

func (s *Server) handlePageMeta(w http.ResponseWriter, r *http.Request) {
	meta, err := s.st.PageMeta(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) handleVersions(w http.ResponseWriter, r *http.Request) {
	vs, err := s.st.Versions(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vs)
}

// updateItemReq renames and/or moves an item. ParentID is raw so that an
// explicit null (move to the root) differs from leaving it out (don't move).
type updateItemReq struct {
	Name     *string         `json:"name"`
	ParentID json.RawMessage `json:"parentId"`
}

func (s *Server) handleUpdateItem(w http.ResponseWriter, r *http.Request) {
	var req updateItemReq
	if !decode(w, r, &req) {
		return
	}
	ctx, sub, kind, id := r.Context(), subOf(r.Context()), itemKind(r), chi.URLParam(r, "id")
	if req.ParentID != nil {
		var dest *string
		if err := json.Unmarshal(req.ParentID, &dest); err != nil {
			http.Error(w, "parentId must be a folder id or null", http.StatusBadRequest)
			return
		}
		if err := s.st.Move(ctx, sub, kind, id, dest); err != nil {
			httpError(w, err)
			return
		}
	}
	if req.Name != nil {
		if err := s.st.Rename(ctx, sub, kind, id, *req.Name); err != nil {
			httpError(w, err)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleArchive(w http.ResponseWriter, r *http.Request) {
	if err := s.st.Archive(r.Context(), subOf(r.Context()), itemKind(r), chi.URLParam(r, "id")); err != nil {
		httpError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUnarchive(w http.ResponseWriter, r *http.Request) {
	if err := s.st.Unarchive(r.Context(), subOf(r.Context()), itemKind(r), chi.URLParam(r, "id")); err != nil {
		httpError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleArchived(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.Archived(r.Context(), subOf(r.Context()))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleShared(w http.ResponseWriter, r *http.Request) {
	items, err := s.st.SharedWithMe(r.Context(), subOf(r.Context()))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, items)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	res, err := s.st.Search(r.Context(), subOf(r.Context()), r.URL.Query().Get("q"), 50)
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// itemKind maps the /api/{pages|folders}/... path segment to a store kind.
func itemKind(r *http.Request) store.ItemKind {
	if strings.HasPrefix(r.URL.Path, "/api/folders/") {
		return store.KindFolder
	}
	return store.KindPage
}

func (s *Server) handleListShares(w http.ResponseWriter, r *http.Request) {
	shares, err := s.st.Shares(r.Context(), subOf(r.Context()), itemKind(r), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, shares)
}

type shareReq struct {
	// Email names the subject; Sub may be given instead.
	Email string `json:"email"`
	Sub   string `json:"sub"`
	Role  string `json:"role"`
}

func (s *Server) handleShare(w http.ResponseWriter, r *http.Request) {
	var req shareReq
	if !decode(w, r, &req) {
		return
	}
	role, ok := store.ParseShareRole(req.Role)
	if !ok {
		http.Error(w, `role must be "viewer" or "editor"`, http.StatusBadRequest)
		return
	}
	subject := strings.TrimSpace(req.Sub)
	if subject == "" {
		if strings.TrimSpace(req.Email) == "" {
			http.Error(w, "email is required", http.StatusBadRequest)
			return
		}
		var err error
		if subject, err = s.st.UserByEmail(r.Context(), req.Email); err != nil {
			httpError(w, err)
			return
		}
	}
	if err := s.st.Share(r.Context(), subOf(r.Context()), itemKind(r), chi.URLParam(r, "id"), subject, role); err != nil {
		httpError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUnshare(w http.ResponseWriter, r *http.Request) {
	subject := strings.TrimSpace(r.URL.Query().Get("sub"))
	if subject == "" {
		http.Error(w, "sub query parameter is required", http.StatusBadRequest)
		return
	}
	if err := s.st.Unshare(r.Context(), subOf(r.Context()), itemKind(r), chi.URLParam(r, "id"), subject); err != nil {
		httpError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleView serves a page's stored HTML: the current version, or ?v=N. The
// CSP sandbox puts the page on an opaque origin so its scripts cannot read
// Specola's cookies or call its API.
func (s *Server) handleView(w http.ResponseWriter, r *http.Request) {
	ctx, sub, id := r.Context(), subOf(r.Context()), chi.URLParam(r, "id")
	var (
		html string
		err  error
	)
	if v := r.URL.Query().Get("v"); v != "" {
		n, convErr := strconv.Atoi(v)
		if convErr != nil || n < 1 {
			http.Error(w, "v must be a version number", http.StatusBadRequest)
			return
		}
		html, err = s.st.VersionContent(ctx, sub, id, n)
	} else {
		html, err = s.st.CurrentContent(ctx, sub, id)
	}
	if err != nil {
		httpError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-forms allow-modals")
	_, _ = io.WriteString(w, html)
}

// maxUploadBytes bounds a page uploaded through a grant. Grants exist for pages
// too large to inline in a tool argument, so this is well above the JSON limit.
const maxUploadBytes = 64 << 20

// handleUpload redeems an upload grant with the raw HTML request body.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUploadBytes))
	if err != nil {
		http.Error(w, "body too large or unreadable", http.StatusRequestEntityTooLarge)
		return
	}
	if len(body) == 0 {
		http.Error(w, "empty body: send the HTML as the request body", http.StatusBadRequest)
		return
	}
	id, version, err := s.st.RedeemUpload(r.Context(), chi.URLParam(r, "token"), string(body))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "version": version, "url": s.cfg.AppBaseURL + "/#/p/" + id,
	})
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
	switch {
	case errors.Is(err, store.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
		return
	case errors.Is(err, store.ErrGrantGone):
		http.Error(w, err.Error(), http.StatusGone)
		return
	case errors.Is(err, store.ErrForbidden):
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	case errors.Is(err, store.ErrGrantKind), errors.Is(err, store.ErrUnknownUser), errors.Is(err, store.ErrSelfShare):
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	var invalid *store.ErrInvalid
	if errors.As(err, &invalid) {
		http.Error(w, invalid.Reason, http.StatusBadRequest)
		return
	}
	slog.Error("request failed", "err", err)
	http.Error(w, "internal error", http.StatusInternalServerError)
}
