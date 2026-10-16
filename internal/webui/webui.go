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

func Handler() http.Handler {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err)
	}
	files := http.FileServer(http.FS(sub))
	index, _ := fs.ReadFile(sub, "index.html")

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
		if strings.HasPrefix(p, "assets/") {
			// Vite puts a content hash in these names: a new build is a new URL.
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
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
