// Package plugin carries the Specola Vite plugin (@specola/vite-plugin, the
// JavaScript in this directory) into the server binary, which serves it as an
// npm package: agents install it straight from their Specola instance, and
// the plugin they get always matches the server. See docs/spa-bundles.md,
// "Plugin and CLI distribution".
package plugin

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
	"time"
)

// The files npm would pack: package.json and what its "files" lists. Keep in
// sync with package.json (a test checks); never node_modules or the tests.
//
//go:embed package.json index.js index.d.ts lib bin README.md
var sources embed.FS

// npm's own fixed date for packed files, so the tarball is the same bytes on
// every start and in every build.
var packTime = time.Date(1985, time.October, 26, 8, 15, 0, 0, time.UTC)

type manifest struct {
	Name    string            `json:"name"`
	Version string            `json:"version"`
	Files   []string          `json:"files"`
	Bin     map[string]string `json:"bin"`
}

var (
	pkg     = mustManifest()
	tarball = mustPack()

	// Version is the plugin's version, from its package.json.
	Version = pkg.Version
	// TarballName is the file the package is served as, under /tools/.
	TarballName = "specola-vite-plugin-" + pkg.Version + ".tgz"
	// TarballSHA256 is the hex sha256 of Tarball(), e.g. for an ETag.
	TarballSHA256 = func() string { h := sha256.Sum256(tarball); return hex.EncodeToString(h[:]) }()
)

// Tarball is the npm package (a gzipped tar with every file under
// "package/"), built once at startup. It must not be modified.
func Tarball() []byte { return tarball }

// TarballPath is where the server serves the package, from the app's root.
func TarballPath() string { return "/tools/" + TarballName }

// InstallCommand installs the plugin served at tarballURL into a project.
func InstallCommand(tarballURL string) string { return "npm i -D " + tarballURL }

// PublishCommand is what an agent runs in the project directory to build the
// app and upload it as a bundle through uploadURL (a bundle upload link).
func PublishCommand(uploadURL string) string {
	return "npx specola-publish --upload '" + uploadURL + "'"
}

func mustManifest() manifest {
	b, err := sources.ReadFile("package.json")
	if err != nil {
		panic(err)
	}
	var m manifest
	if err := json.Unmarshal(b, &m); err != nil || m.Version == "" {
		panic(fmt.Sprintf("plugin/package.json: %v", err))
	}
	return m
}

// packed reports whether npm would pack the file at p: package.json, or a
// file or directory listed in "files".
func (m manifest) packed(p string) bool {
	if p == "package.json" {
		return true
	}
	for _, f := range m.Files {
		f = strings.TrimSuffix(strings.TrimPrefix(f, "./"), "/")
		if p == f || strings.HasPrefix(p, f+"/") {
			return true
		}
	}
	return false
}

func mustPack() []byte {
	b, err := pack(sources, pkg)
	if err != nil {
		panic(fmt.Sprintf("pack the Vite plugin: %v", err))
	}
	return b
}

// pack builds the npm tarball: files in sorted order, fixed times and owners,
// mode 0755 for the bins and 0644 for the rest.
func pack(fsys fs.FS, m manifest) ([]byte, error) {
	var paths []string
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !m.packed(p) {
			return err
		}
		paths = append(paths, p)
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(paths)
	bins := map[string]bool{}
	for _, b := range m.Bin {
		bins[path.Clean(b)] = true
	}

	var buf bytes.Buffer
	zw, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	tw := tar.NewWriter(zw)
	for _, p := range paths {
		content, err := fs.ReadFile(fsys, p)
		if err != nil {
			return nil, err
		}
		mode := int64(0o644)
		if bins[p] {
			mode = 0o755
		}
		hdr := &tar.Header{
			Typeflag: tar.TypeReg,
			Name:     "package/" + p,
			Mode:     mode,
			Size:     int64(len(content)),
			ModTime:  packTime,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, err
		}
		if _, err := tw.Write(content); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
