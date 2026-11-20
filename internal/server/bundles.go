package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/plugin"

	"github.com/go-chi/chi/v5"
)

// SPA bundles (docs/spa-bundles.md). The plugin's CLI uploads a bundle through
// /upload/bundle/{token} on the app origin, authorized by the grant token
// alone; its files are then served at {assetOrigin}/b/{bundleKey}/{path},
// where the key is the capability.

// minPluginVersion is the oldest @specola/vite-plugin whose uploads this
// server accepts.
const minPluginVersion = "1.0.0"

// maxManifestBytes bounds a manifest: MaxBundleFiles entries with long paths
// fit well within it.
const maxManifestBytes = 4 << 20

// basePlaceholder starts every reference to a bundle file in a bundle's
// index.html, as the plugin writes it.
const basePlaceholder = "__SPECOLA_BASE__/"

// assetOrigin is where bundle files are served: the view origin when there is
// one, else the app's own.
func (s *Server) assetOrigin() string {
	if s.cfg.ViewOrigin != "" {
		return s.cfg.ViewOrigin
	}
	return s.cfg.AppBaseURL
}

// bundleBase is the URL a bundle's files are under, ending in "/".
func (s *Server) bundleBase(key string) string {
	return s.assetOrigin() + "/b/" + key + "/"
}

// pageHTML is the HTML to serve for a version: a bundle's index.html has its
// placeholder pointed at the bundle's files. The stored HTML keeps it.
func (s *Server) pageHTML(html, bundleKey string) string {
	if bundleKey == "" {
		return html
	}
	return strings.ReplaceAll(html, basePlaceholder, s.bundleBase(bundleKey))
}

// boot is the SDK's boot data for a version with bundle key key ("" for a
// plain page) served under basename.
func (s *Server) boot(key, basename string) bootData {
	b := bootData{Basename: basename}
	if key != "" {
		b.Base = s.bundleBase(key)
	}
	return b
}

// handleBundleFile serves one file of a bundle. The files run inside the
// page's opaque origin, which loads them cross-origin: hence CORS for anyone
// and a cross-origin resource policy. A file under a key never changes.
//
// Anyone with the key may ask, so the content is read lazily, a chunk at a
// time: a HEAD or a 304 reads none of it, a range only the chunks it covers.
func (s *Server) handleBundleFile(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "key")
	// The decoded path: the files' names may need escaping in a URL.
	p := strings.TrimPrefix(r.URL.Path, "/b/"+key+"/")
	f, err := s.st.BundleFileInfo(r.Context(), key, p)
	if err != nil {
		httpError(w, err)
		return
	}
	h := w.Header()
	h.Set("Content-Type", f.ContentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-forms allow-modals")
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Cross-Origin-Resource-Policy", "cross-origin")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Cache-Control", "public, max-age=31536000, immutable")
	h.Set("ETag", `"`+f.SHA256+`"`)
	http.ServeContent(w, r, "", time.Time{}, &blobReader{st: s.st, ctx: r.Context(), sum: f.SHA256, size: f.Size})
}

// bundleChunkBytes is how much of a bundle file one database read fetches.
var bundleChunkBytes int64 = 1 << 20

// blobReader reads a bundle file from the database as it is read, one chunk
// at a time, for http.ServeContent (which only seeks to learn the size, and
// to the start of a range).
type blobReader struct {
	st     *store.Store
	ctx    context.Context
	sum    string
	size   int64
	off    int64
	buf    []byte // the chunk at bufOff
	bufOff int64
}

func (b *blobReader) Read(p []byte) (int, error) {
	if b.off >= b.size {
		return 0, io.EOF
	}
	if b.off < b.bufOff || b.off >= b.bufOff+int64(len(b.buf)) {
		n := min(bundleChunkBytes, b.size-b.off)
		chunk, err := b.st.ReadBundleBlob(b.ctx, b.sum, b.off, n)
		if err != nil {
			return 0, err
		}
		b.buf, b.bufOff = chunk, b.off
	}
	n := copy(p, b.buf[b.off-b.bufOff:])
	b.off += int64(n)
	return n, nil
}

func (b *blobReader) Seek(offset int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += b.off
	case io.SeekEnd:
		offset += b.size
	default:
		return 0, errors.New("seek: invalid whence")
	}
	if offset < 0 {
		return 0, errors.New("seek: negative position")
	}
	b.off = offset
	return offset, nil
}

// bundleLimits are the limits the CLI checks before building.
type bundleLimits struct {
	MaxFiles       int `json:"maxFiles"`
	MaxFileBytes   int `json:"maxFileBytes"`
	MaxIndexBytes  int `json:"maxIndexBytes"`
	MaxBundleBytes int `json:"maxBundleBytes"`
}

type bundleUploadInfo struct {
	*store.BundleUpload
	Limits           bundleLimits `json:"limits"`
	MinPluginVersion string       `json:"minPluginVersion"`
}

func (s *Server) handleBundleUploadInfo(w http.ResponseWriter, r *http.Request) {
	u, err := s.st.BundleUploadInfo(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, bundleUploadInfo{
		BundleUpload: u,
		Limits: bundleLimits{
			MaxFiles:       store.MaxBundleFiles,
			MaxFileBytes:   store.MaxBundleFileBytes,
			MaxIndexBytes:  store.MaxBundleIndexSize,
			MaxBundleBytes: store.MaxBundleBytes,
		},
		MinPluginVersion: minPluginVersion,
	})
}

// grantError answers the error of the request's bundle upload token, if it
// has one (unknown 404, used or expired 410, not a bundle grant 400), and
// reports whether it did. The protocol reports these before any problem with
// the request's body (docs/spa-bundles.md, Upload protocol).
func (s *Server) grantError(w http.ResponseWriter, r *http.Request) bool {
	if _, err := s.st.BundleUploadInfo(r.Context(), chi.URLParam(r, "token")); err != nil {
		httpError(w, err)
		return true
	}
	return false
}

type manifestReq struct {
	PluginVersion string             `json:"pluginVersion"`
	Files         []store.BundleFile `json:"files"`
}

func (s *Server) handleBundleManifest(w http.ResponseWriter, r *http.Request) {
	var req manifestReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxManifestBytes)).Decode(&req); err != nil {
		if s.grantError(w, r) {
			return
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, fmt.Sprintf("manifest is over %d bytes", maxManifestBytes), http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !versionAtLeast(req.PluginVersion, minPluginVersion) {
		if s.grantError(w, r) {
			return
		}
		http.Error(w, fmt.Sprintf(
			"plugin version %q is too old for this server, which needs %s or later: update @specola/vite-plugin with %s",
			req.PluginVersion, minPluginVersion, plugin.InstallCommand(s.pluginURL())), http.StatusBadRequest)
		return
	}
	missing, err := s.st.SetBundleManifest(r.Context(), chi.URLParam(r, "token"), req.Files)
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string][]string{"missing": missing})
}

// handleBundleBlob stores one file of a bundle upload. The store checks the
// grant and the manifest before reading the body, and reads no more than the
// file's size.
func (s *Server) handleBundleBlob(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > store.MaxBundleFileBytes {
		if s.grantError(w, r) {
			return
		}
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
		return
	}
	body := http.MaxBytesReader(w, r.Body, store.MaxBundleFileBytes)
	err := s.st.PutBundleBlob(r.Context(), chi.URLParam(r, "token"), chi.URLParam(r, "sha256"), body)
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		http.Error(w, "body too large", http.StatusRequestEntityTooLarge)
	case err != nil:
		httpError(w, err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

type commitReq struct {
	Note string `json:"note"`
}

func (s *Server) handleBundleCommit(w http.ResponseWriter, r *http.Request) {
	var req commitReq
	// The body is optional: no note keeps the grant's.
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		if s.grantError(w, r) {
			return
		}
		http.Error(w, "invalid JSON body: "+err.Error(), http.StatusBadRequest)
		return
	}
	id, version, err := s.st.CommitBundle(r.Context(), chi.URLParam(r, "token"), req.Note)
	if err != nil {
		httpError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "version": version, "url": s.cfg.AppBaseURL + "/#/p/" + id,
	})
}

// bundleUploadReq asks for a bundle upload grant: a new page (title, and
// optionally folderId) or a new version of page id.
type bundleUploadReq struct {
	Kind     string  `json:"kind"`
	Title    string  `json:"title"`
	FolderID *string `json:"folderId"`
	ID       string  `json:"id"`
	Note     string  `json:"note"`
}

// handleCreateBundleUpload mints a bundle upload grant and answers with the
// command that publishes the bundle from the project directory.
func (s *Server) handleCreateBundleUpload(w http.ResponseWriter, r *http.Request) {
	var req bundleUploadReq
	if !decode(w, r, &req) {
		return
	}
	gr := store.GrantRequest{Sub: subOf(r.Context()), Note: req.Note, Bundle: true}
	switch req.Kind {
	case "new":
		if strings.TrimSpace(req.Title) == "" {
			http.Error(w, "title is required for a new page", http.StatusBadRequest)
			return
		}
		gr.Kind, gr.Name, gr.FolderID = store.GrantUploadNew, strings.TrimSpace(req.Title), req.FolderID
	case "version":
		if req.ID == "" {
			http.Error(w, "id is required for a new version", http.StatusBadRequest)
			return
		}
		gr.Kind, gr.AssetID = store.GrantUploadVersion, req.ID
	default:
		http.Error(w, `kind must be "new" or "version"`, http.StatusBadRequest)
		return
	}
	token, expires, err := s.st.MintGrant(r.Context(), gr, store.BundleGrantTTL)
	if err != nil {
		httpError(w, err)
		return
	}
	uploadURL := s.cfg.AppBaseURL + "/upload/bundle/" + token
	writeJSON(w, http.StatusCreated, map[string]any{
		"uploadUrl": uploadURL,
		"expiresAt": expires,
		"command":   plugin.PublishCommand(uploadURL),
		// For the app's hint: the plugin must be installed once first.
		"pluginInstall": plugin.InstallCommand(s.pluginURL()),
	})
}

// pluginURL is where this instance serves the Vite plugin's npm package.
func (s *Server) pluginURL() string { return s.cfg.AppBaseURL + plugin.TarballPath() }

// handleTool serves the Vite plugin's npm package, under its versioned name
// only: the name changes with each version, so it is cached for good.
func (s *Server) handleTool(w http.ResponseWriter, r *http.Request) {
	if chi.URLParam(r, "*") != plugin.TarballName {
		http.Error(w, "not found: this server has "+s.pluginURL(), http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/gzip")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("ETag", `"`+plugin.TarballSHA256+`"`)
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(plugin.Tarball()))
}

// versionFilesResp lists a version's bundle files; base is where they are
// served, "" for a plain version.
type versionFilesResp struct {
	Bundle bool                `json:"bundle"`
	Base   string              `json:"base"`
	Files  []store.VersionFile `json:"files"`
}

func (s *Server) handleVersionFiles(w http.ResponseWriter, r *http.Request) {
	v, err := strconv.Atoi(chi.URLParam(r, "v"))
	if err != nil || v < 1 {
		http.Error(w, "version must be a number", http.StatusBadRequest)
		return
	}
	key, files, err := s.st.VersionFiles(r.Context(), subOf(r.Context()), chi.URLParam(r, "id"), v)
	if err != nil {
		httpError(w, err)
		return
	}
	resp := versionFilesResp{Bundle: key != "", Files: files}
	if key != "" {
		resp.Base = s.bundleBase(key)
	}
	writeJSON(w, http.StatusOK, resp)
}

// versionAtLeast reports whether version v ("1.2.3", optionally with a
// pre-release or build suffix, which is ignored) is at least min.
func versionAtLeast(v, min string) bool {
	parse := func(s string) ([3]int, bool) {
		var n [3]int
		if i := strings.IndexAny(s, "-+"); i >= 0 {
			s = s[:i]
		}
		parts := strings.Split(strings.TrimPrefix(s, "v"), ".")
		if len(parts) != 3 {
			return n, false
		}
		for i, p := range parts {
			x, err := strconv.Atoi(p)
			if err != nil || x < 0 {
				return n, false
			}
			n[i] = x
		}
		return n, true
	}
	a, ok := parse(v)
	b, _ := parse(min)
	if !ok {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return true
}
