// Package webui embeds the built Svelte SPA and serves it with a history-API
// fallback (unknown non-asset paths return index.html).
package webui

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist
var dist embed.FS

var (
	sub   = mustSub()
	index = mustRead(sub, "index.html")
)

func mustSub() fs.FS {
	s, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	return s
}

func mustRead(f fs.FS, name string) []byte {
	b, err := fs.ReadFile(f, name)
	if err != nil {
		panic(err)
	}
	return b
}

// Index is the SPA's shell, index.html, which page apps serve with their
// own head (internal/server/apps.go).
func Index() []byte { return index }

func Handler() http.Handler {
	files := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			serveIndex(w, index)
			return
		}
		if _, err := fs.Stat(sub, p); err != nil {
			// Not a real file → SPA route, hand back the shell.
			serveIndex(w, index)
			return
		}
		switch {
		case strings.HasPrefix(p, "assets/"):
			// Vite puts a content hash in these names: a new build is a new URL.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case p == "sw.js" || p == "manifest.webmanifest":
			// The service worker names the files of the running build, like the
			// shell, so each deploy must reach the browser.
			w.Header().Set("Cache-Control", "no-cache")
			if p == "manifest.webmanifest" {
				w.Header().Set("Content-Type", "application/manifest+json")
			}
		default:
			// Fixed names (the favicon): reuse for a day.
			w.Header().Set("Cache-Control", "public, max-age=86400")
		}
		files.ServeHTTP(w, r)
	})
}

// serveIndex sends the shell. It names the hashed bundle of the running
// build, so it must be revalidated or a deploy wouldn't reach the browser.
func serveIndex(w http.ResponseWriter, index []byte) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(index)
}
