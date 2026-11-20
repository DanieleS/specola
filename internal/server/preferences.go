package server

import (
	"net/http"

	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Agent preferences and folder conventions (docs/agent-preferences.md).

func (s *Server) handlePreferences(w http.ResponseWriter, r *http.Request) {
	p, err := s.st.Preferences(r.Context(), subOf(r.Context()))
	if err != nil {
		httpError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleSetPreferences(w http.ResponseWriter, r *http.Request) {
	var req store.PreferencesInput
	if !decode(w, r, &req) {
		return
	}
	p, err := s.st.SetPreferences(r.Context(), subOf(r.Context()), req)
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (s *Server) handleFolderConventions(w http.ResponseWriter, r *http.Request) {
	c, err := s.st.FolderConventions(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

type conventionsReq struct {
	Text       string  `json:"text"`
	StyleRefID *string `json:"styleRefId"`
}

func (s *Server) handleSetFolderConventions(w http.ResponseWriter, r *http.Request) {
	var req conventionsReq
	if !decode(w, r, &req) {
		return
	}
	c, err := s.st.SetFolderConventions(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"), req.Text, req.StyleRefID)
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (s *Server) handleDeleteFolderConventions(w http.ResponseWriter, r *http.Request) {
	c, err := s.st.DeleteFolderConventions(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, c)
}
