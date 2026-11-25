package server

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Page secrets (docs/page-backends.md, "Secrets (step 3)"): values a page's
// owners set for the names its backend declares, which reach the backend as
// ctx.secrets and nobody else, ever: there is no route that reads a value
// back. Owners and editors see which names are declared and set; only owners
// set and remove them (an editor can still read them, by publishing code
// that prints them: see Trust model).

// routesSecrets registers the secrets routes, under /api (session).
func (s *Server) routesSecrets(r chi.Router) {
	r.Get("/pages/{id}/secrets", s.handleListSecrets)
	r.Put("/pages/{id}/secrets/{name}", s.handleSetSecret)
	r.Delete("/pages/{id}/secrets/{name}", s.handleDeleteSecret)
}

// secretsError answers a store error about a page's secrets, as the other
// backend routes do: X-Specola-Error and a JSON body.
func secretsError(w http.ResponseWriter, err error) {
	var invalid *store.ErrInvalid
	if errors.As(err, &invalid) {
		backendError(w, http.StatusBadRequest, "bad-request", invalid.Reason)
		return
	}
	backendAccessError(w, err)
}

func (s *Server) handleListSecrets(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	list, err := s.st.ListPageSecrets(ctx, subOf(ctx), chi.URLParam(r, "id"))
	if err != nil {
		secretsError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, map[string][]store.SecretInfo{"secrets": list})
}

// maxSecretBody bounds PUT's JSON body: a value of at most 8 KiB, which JSON
// escaping can make up to six times as long.
const maxSecretBody = 64 << 10

func (s *Server) handleSetSecret(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// Without backends there is no key to encrypt with, and nothing would
	// ever read the value.
	if s.runner == nil || len(s.cfg.SecretsKey) == 0 {
		backendError(w, http.StatusServiceUnavailable, "backend-disabled", "page backends are not enabled on this instance")
		return
	}
	var req struct {
		Value *string `json:"value"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxSecretBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil || req.Value == nil {
		backendError(w, http.StatusBadRequest, "bad-request", `the body must be {"value": "…"}`)
		return
	}
	err := s.st.SetPageSecret(ctx, subOf(ctx), chi.URLParam(r, "id"), chi.URLParam(r, "name"), *req.Value, s.cfg.SecretsKey)
	if err != nil {
		secretsError(w, err)
		return
	}
	slog.Info("page secret set", "page", chi.URLParam(r, "id"), "name", chi.URLParam(r, "name"), "by", subOf(ctx))
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleDeleteSecret(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if err := s.st.DeletePageSecret(ctx, subOf(ctx), chi.URLParam(r, "id"), chi.URLParam(r, "name")); err != nil {
		secretsError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// backendSecretsMissing is the page meta's backendSecretsMissing: the names
// the current version declares and that have no value, for its owners and
// editors (who can act on it); nil, and so left out, for anyone else and
// for a page without a backend.
func (s *Server) backendSecretsMissing(r *http.Request, meta *store.PageMeta) ([]string, error) {
	if !meta.Backend || (meta.Role != store.RoleOwner.String() && meta.Role != store.RoleEditor.String()) {
		return nil, nil
	}
	return s.st.MissingPageSecrets(r.Context(), meta.ID)
}
