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
			r.Post("/pages/{id}/versions", s.handleAddVersion)
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
	version, err := s.st.AddVersion(r.Context(), chi.URLParam(r, "id"), req.HTML, subOf(r.Context()))
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

// handleView serves a page's stored HTML. The CSP sandbox puts the page on an
// opaque origin so its scripts cannot read Specola's cookies or call its API.
func (s *Server) handleView(w http.ResponseWriter, r *http.Request) {
	html, err := s.st.CurrentContent(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"))
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
	case errors.Is(err, store.ErrGrantKind):
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	slog.Error("request failed", "err", err)
	http.Error(w, "internal error", http.StatusInternalServerError)
}
