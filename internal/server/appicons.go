package server

import (
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/danieles/specola/internal/pageapp"
	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Generated icons are drawn by pageapp; served here, memoised.

// iconSizes are the sizes generated icons come in.
var iconSizes = map[string]int{"192.png": 192, "512.png": 512}

// iconCache holds the icons drawn, by URL path: at most 12 colors × 2 sizes
// per letter in use.
var iconCache sync.Map

func handleGeneratedIcon(w http.ResponseWriter, r *http.Request) {
	color := chi.URLParam(r, "color")
	size, okSize := iconSizes[chi.URLParam(r, "size")]
	letter, err := url.PathUnescape(chi.URLParam(r, "letter"))
	l, n := utf8.DecodeRuneInString(letter)
	if !okSize || err != nil || !slices.Contains(pageapp.Palette, color) || n != len(letter) ||
		!(unicode.IsLetter(l) || unicode.IsDigit(l)) || unicode.ToUpper(l) != l || !pageapp.Drawable(l) {
		http.NotFound(w, r)
		return
	}
	key := color + "/" + string(l) + "/" + strconv.Itoa(size)
	img, ok := iconCache.Load(key)
	if !ok {
		b, err := pageapp.DrawIcon(color, l, size)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		img, _ = iconCache.LoadOrStore(key, b)
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(img.([]byte))
}

// handleUploadedIcon serves an icon an author uploaded, by its sha256: only
// one some page's app uses.
func (s *Server) handleUploadedIcon(w http.ResponseWriter, r *http.Request) {
	sha, ok := strings.CutSuffix(chi.URLParam(r, "file"), ".png")
	if !ok || len(sha) != 64 {
		http.NotFound(w, r)
		return
	}
	b, err := s.st.AppIcon(r.Context(), sha)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			http.NotFound(w, r)
			return
		}
		httpError(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(b)
}
