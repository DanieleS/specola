package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/danieles/specola/internal/testdb"
)

func TestValidateBundlePath(t *testing.T) {
	for _, p := range []string{
		"index.html", "assets/index-ab12.js", "a/b/c/d.css", "fonts/Inter Var.woff2",
		"naïve/日本.png", ".well-known/x.json", "a..b/c", "x.HTML.txt", strings.Repeat("a", 512),
	} {
		if err := ValidateBundlePath(p); err != nil {
			t.Errorf("%q: %v, want valid", p, err)
		}
	}
	for name, p := range map[string]string{
		"empty":          "",
		"too long":       strings.Repeat("a", 513),
		"bad utf-8":      "a\xffb.js",
		"control":        "a\tb.js",
		"DEL":            "a\x7fb.js",
		"C1 control":     "a\u0085b.js",
		"backslash":      `a\b.js`,
		"question mark":  "a?b.js",
		"hash":           "a#b.js",
		"percent":        "a%20b.js",
		"absolute":       "/index.js",
		"empty segment":  "a//b.js",
		"trailing slash": "a/",
		"dot segment":    "./a.js",
		"dot dot":        "a/../b.js",
		"only dot dot":   "..",
		"nested index":   "sub/index.html",
		"other html":     "about.html",
		"htm":            "x.htm",
		"upper html":     "INDEX.HTML",
		"mixed case":     "Index.html",
	} {
		var invalid *ErrInvalid
		if err := ValidateBundlePath(p); !errors.As(err, &invalid) {
			t.Errorf("%s (%q): %v, want ErrInvalid", name, p, err)
		}
	}
}

// file makes a manifest entry for content at path.
func file(path, content string) BundleFile {
	sum := sha256.Sum256([]byte(content))
	return BundleFile{Path: path, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(content))}
}

func TestValidateManifest(t *testing.T) {
	index := file("index.html", "<p>hi</p>")
	ok := []BundleFile{index, file("a.js", "1")}
	if err := ValidateManifest(ok); err != nil {
		t.Fatalf("valid manifest: %v", err)
	}
	big := func(path string, size int64) BundleFile {
		f := file(path, path)
		f.Size = size
		return f
	}
	many := []BundleFile{index}
	for i := 0; i < MaxBundleFiles; i++ {
		many = append(many, file(fmt.Sprintf("f%d.js", i), fmt.Sprint(i)))
	}
	var tooBig []BundleFile
	tooBig = append(tooBig, index)
	for i := 0; i < 5; i++ {
		tooBig = append(tooBig, big(fmt.Sprintf("big%d.bin", i), MaxBundleFileBytes))
	}
	badHash := file("a.js", "1")
	badHash.SHA256 = strings.ToUpper(badHash.SHA256)
	sameHashOtherSize := file("b.js", "1")
	sameHashOtherSize.Size = 2
	for name, files := range map[string][]BundleFile{
		"no files":                     nil,
		"missing index.html":           {file("a.js", "1")},
		"too many files":               many,
		"file too large":               {index, big("a.bin", MaxBundleFileBytes+1)},
		"negative size":                {index, big("a.bin", -1)},
		"index too large":              {big("index.html", MaxBundleIndexSize+1)},
		"total too large":              tooBig,
		"extra html":                   {index, file("about.html", "x")},
		"duplicate path":               {index, file("a.js", "1"), file("a.js", "2")},
		"invalid path":                 {index, file("../a.js", "1")},
		"uppercase hash":               {index, badHash},
		"same hash with another size":  {index, file("a.js", "1"), sameHashOtherSize},
		"index listed twice, as dupes": {index, index},
	} {
		var invalid *ErrInvalid
		if err := ValidateManifest(files); !errors.As(err, &invalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
}

func TestBundleContentType(t *testing.T) {
	for p, want := range map[string]string{
		"a.js": "text/javascript; charset=utf-8", "a.MJS": "text/javascript; charset=utf-8",
		"a.css": "text/css; charset=utf-8", "a.map": "application/json", "a.wasm": "application/wasm",
		"a.svg": "image/svg+xml", "a.woff2": "font/woff2", "a.webmanifest": "application/manifest+json",
		"a.glb": "model/gltf-binary", "a": "application/octet-stream", "a.exe": "application/octet-stream",
	} {
		if got := BundleContentType(p); got != want {
			t.Errorf("%s: %q, want %q", p, got, want)
		}
	}
}

// bundle is a bundle's files, by path.
type bundle map[string]string

func (b bundle) manifest() []BundleFile {
	var files []BundleFile
	for p, c := range b {
		files = append(files, file(p, c))
	}
	return files
}

// uploadBundle runs a whole bundle upload through token and returns the page
// and version it made.
func uploadBundle(t *testing.T, st *Store, token string, b bundle, note string) (string, int) {
	t.Helper()
	ctx := context.Background()
	missing, err := st.SetBundleManifest(ctx, token, b.manifest())
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}
	for _, f := range b.manifest() {
		if slices.Contains(missing, f.SHA256) {
			if err := st.PutBundleBlob(ctx, token, f.SHA256, strings.NewReader(b[f.Path])); err != nil {
				t.Fatalf("put %s: %v", f.Path, err)
			}
		}
	}
	id, v, err := st.CommitBundle(ctx, token, note, true)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	return id, v
}

func TestBundleUpload(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()

	mint := func(req GrantRequest) string {
		t.Helper()
		req.Bundle = true
		token, _, err := st.MintGrant(ctx, req, BundleGrantTTL)
		if err != nil {
			t.Fatalf("mint %+v: %v", req, err)
		}
		return token
	}
	app := bundle{
		"index.html":       `<script type="module" src="__SPECOLA_BASE__/assets/app.js"></script><p>Hello bundle</p>`,
		"assets/app.js":    `import "./dep.js"`,
		"assets/dep.js":    `console.log(1)`,
		"assets/same.js":   `console.log(1)`, // same content as dep.js: one blob
		"assets/style.css": `p{}`,
	}

	t.Run("info", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "App"})
		u, err := st.BundleUploadInfo(ctx, token)
		if err != nil || u.Kind != "new" || u.Title != "App" || u.PageID != "" || time.Until(u.ExpiresAt) < 29*time.Minute {
			t.Fatalf("info = %+v, %v", u, err)
		}
		plain, _, _ := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "Plain"}, time.Minute)
		if _, err := st.BundleUploadInfo(ctx, plain); !errors.Is(err, ErrGrantKind) {
			t.Fatalf("plain grant: %v, want ErrGrantKind", err)
		}
		if _, _, err := st.RedeemUpload(ctx, token, "<p>x</p>"); !errors.Is(err, ErrGrantKind) {
			t.Fatalf("redeem bundle grant as plain upload: %v, want ErrGrantKind", err)
		}
		if _, err := st.BundleUploadInfo(ctx, "nope"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown token: %v, want ErrNotFound", err)
		}
	})

	var page string
	t.Run("new page", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "App", Note: "from grant"})
		missing, err := st.SetBundleManifest(ctx, token, app.manifest())
		if err != nil || len(missing) != 4 {
			t.Fatalf("missing = %v, %v; want 4 distinct blobs", missing, err)
		}
		// Committing before uploading lists what is missing.
		_, _, err = st.CommitBundle(ctx, token, "", true)
		var mb *ErrMissingBlobs
		if !errors.As(err, &mb) || !slices.Equal(mb.Missing, missing) {
			t.Fatalf("early commit: %v, want missing %v", err, missing)
		}

		var v int
		page, v = uploadBundle(t, st, token, app, "")
		if v != 1 {
			t.Fatalf("version = %d", v)
		}
		meta, err := st.PageMeta(ctx, "alice", page)
		if err != nil || !meta.Bundle || meta.Name != "App" {
			t.Fatalf("meta = %+v, %v", meta, err)
		}
		html, key, err := st.VersionPage(ctx, "alice", page, 1)
		if err != nil || html != app["index.html"] || len(key) != 43 {
			t.Fatalf("version page = %q, %q, %v", html, key, err)
		}
		vs, _ := st.Versions(ctx, "alice", page)
		if len(vs) != 1 || !vs[0].Bundle || vs[0].Note == nil || *vs[0].Note != "from grant" {
			t.Fatalf("versions = %+v", vs)
		}
		k, files, err := st.VersionFiles(ctx, "alice", page, 1)
		if err != nil || k != key || len(files) != 4 || files[0].Path != "assets/app.js" || files[0].ContentType != "text/javascript; charset=utf-8" {
			t.Fatalf("files = %q, %+v, %v", k, files, err)
		}
		f, err := st.BundleFile(ctx, key, "assets/style.css")
		if err != nil || string(f.Content) != "p{}" || f.ContentType != "text/css; charset=utf-8" {
			t.Fatalf("file = %+v, %v", f, err)
		}
		if _, err := st.BundleFile(ctx, key, "index.html"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("index.html as a file: %v, want ErrNotFound", err)
		}
		if res, _ := st.Search(ctx, "alice", "bundle", 10); len(res) != 1 {
			t.Fatalf("search found %d pages, want 1", len(res))
		}
		// Used.
		if _, err := st.SetBundleManifest(ctx, token, app.manifest()); !errors.Is(err, ErrGrantGone) {
			t.Fatalf("manifest after commit: %v, want ErrGrantGone", err)
		}
		if _, _, err := st.CommitBundle(ctx, token, "", true); !errors.Is(err, ErrGrantGone) {
			t.Fatalf("second commit: %v, want ErrGrantGone", err)
		}
	})

	t.Run("new version dedupes blobs", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: page})
		next := bundle{"index.html": app["index.html"], "assets/app.js": app["assets/app.js"], "assets/new.js": "new"}
		missing, err := st.SetBundleManifest(ctx, token, next.manifest())
		// index.html is the version's content, not a file of it: it is sent
		// again.
		want := []string{file("x", "new").SHA256, file("x", app["index.html"]).SHA256}
		slices.Sort(want)
		if err != nil || !slices.Equal(missing, want) {
			t.Fatalf("missing = %v, %v; want only the new file and index.html", missing, err)
		}
		_, v := uploadBundle(t, st, token, next, "commit note")
		if v != 2 {
			t.Fatalf("version = %d", v)
		}
		vs, _ := st.Versions(ctx, "alice", page)
		if vs[0].Note == nil || *vs[0].Note != "commit note" {
			t.Fatalf("note = %v", vs[0].Note)
		}
		_, k1, _ := st.VersionPage(ctx, "alice", page, 1)
		_, k2, _ := st.VersionPage(ctx, "alice", page, 2)
		if k1 == k2 {
			t.Fatal("two versions share a key")
		}
		if _, err := st.BundleFile(ctx, k2, "assets/dep.js"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("v2 has v1's file: %v", err)
		}
	})

	t.Run("blob checks", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "Blobs"})
		b := bundle{"index.html": "<p>blob checks</p>", "x.js": "unique content for blob checks"}
		x := file("x.js", b["x.js"])
		var invalid *ErrInvalid
		if err := st.PutBundleBlob(ctx, token, x.SHA256, strings.NewReader(b["x.js"])); !errors.As(err, &invalid) {
			t.Fatalf("put before manifest: %v, want ErrInvalid", err)
		}
		if _, err := st.SetBundleManifest(ctx, token, b.manifest()); err != nil {
			t.Fatal(err)
		}
		other := file("y.js", "not in the manifest")
		for name, put := range map[string]func() error{
			"unknown hash": func() error {
				return st.PutBundleBlob(ctx, token, other.SHA256, strings.NewReader("not in the manifest"))
			},
			"wrong size": func() error { return st.PutBundleBlob(ctx, token, x.SHA256, strings.NewReader(b["x.js"]+"!")) },
			"wrong hash": func() error {
				body := []byte(b["x.js"])
				body[0] ^= 1
				return st.PutBundleBlob(ctx, token, x.SHA256, bytes.NewReader(body))
			},
		} {
			if err := put(); !errors.As(err, &invalid) {
				t.Errorf("%s: %v, want ErrInvalid", name, err)
			}
		}
		// Idempotent.
		for i := 0; i < 2; i++ {
			if err := st.PutBundleBlob(ctx, token, x.SHA256, strings.NewReader(b["x.js"])); err != nil {
				t.Fatalf("put #%d: %v", i, err)
			}
		}
	})

	t.Run("index.html must be UTF-8", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "Bad"})
		b := bundle{"index.html": "<p>\xff</p>"}
		missing, err := st.SetBundleManifest(ctx, token, b.manifest())
		if err != nil || len(missing) != 1 {
			t.Fatal(missing, err)
		}
		if err := st.PutBundleBlob(ctx, token, missing[0], strings.NewReader(b["index.html"])); err != nil {
			t.Fatal(err)
		}
		var invalid *ErrInvalid
		if _, _, err := st.CommitBundle(ctx, token, "", true); !errors.As(err, &invalid) {
			t.Fatalf("commit: %v, want ErrInvalid", err)
		}
	})

	t.Run("expired", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: page})
		if _, err := pool.Exec(ctx, `UPDATE asset_grant SET expires_at = now() - interval '1 second' WHERE secret_hash = $1`, hashToken(token)); err != nil {
			t.Fatal(err)
		}
		if _, err := st.BundleUploadInfo(ctx, token); !errors.Is(err, ErrGrantGone) {
			t.Fatalf("info: %v, want ErrGrantGone", err)
		}
		if _, _, err := st.CommitBundle(ctx, token, "", true); !errors.Is(err, ErrGrantGone) {
			t.Fatalf("commit: %v, want ErrGrantGone", err)
		}
	})

	t.Run("access lost before commit", func(t *testing.T) {
		folder, _ := st.CreateFolder(ctx, nil, "Shared", "alice")
		if err := st.Share(ctx, "alice", KindFolder, folder, "bob", RoleEditor); err != nil {
			t.Fatal(err)
		}
		token := mint(GrantRequest{Kind: GrantUploadNew, Sub: "bob", Name: "Bob's", FolderID: &folder})
		b := bundle{"index.html": "<p>bob</p>"}
		missing, _ := st.SetBundleManifest(ctx, token, b.manifest())
		if err := st.PutBundleBlob(ctx, token, missing[0], strings.NewReader(b["index.html"])); err != nil {
			t.Fatal(err)
		}
		if err := st.Unshare(ctx, "alice", KindFolder, folder, "bob"); err != nil {
			t.Fatal(err)
		}
		if _, _, err := st.CommitBundle(ctx, token, "", true); !errors.Is(err, ErrNotFound) {
			t.Fatalf("commit: %v, want ErrNotFound", err)
		}
	})

	t.Run("restore copies files under a new key", func(t *testing.T) {
		v, err := st.RestoreVersion(ctx, "alice", page, 1, "back")
		if err != nil || v != 3 {
			t.Fatalf("restore = %d, %v", v, err)
		}
		_, k1, _ := st.VersionPage(ctx, "alice", page, 1)
		_, k3, _ := st.VersionPage(ctx, "alice", page, 3)
		if k3 == "" || k3 == k1 {
			t.Fatalf("restored key %q (v1 %q)", k3, k1)
		}
		_, f1, _ := st.VersionFiles(ctx, "alice", page, 1)
		_, f3, _ := st.VersionFiles(ctx, "alice", page, 3)
		if !slices.Equal(f1, f3) {
			t.Fatalf("files differ:\n%+v\n%+v", f1, f3)
		}
		if meta, _ := st.PageMeta(ctx, "alice", page); !meta.Bundle {
			t.Fatal("restored bundle isn't a bundle")
		}
	})

	t.Run("plain version after a bundle", func(t *testing.T) {
		v, err := st.AddVersion(ctx, page, "<p>plain</p>", "", "alice")
		if err != nil {
			t.Fatal(err)
		}
		meta, _ := st.PageMeta(ctx, "alice", page)
		key, files, err := st.VersionFiles(ctx, "alice", page, v)
		if meta.Bundle || key != "" || len(files) != 0 || err != nil {
			t.Fatalf("plain version: bundle %v, key %q, files %v, %v", meta.Bundle, key, files, err)
		}
		// Restoring a plain version makes a plain version.
		v, _ = st.RestoreVersion(ctx, "alice", page, v, "")
		if _, key, _ := st.VersionPage(ctx, "alice", page, v); key != "" {
			t.Fatalf("restored plain version has key %q", key)
		}
	})

	t.Run("archived page hides its files", func(t *testing.T) {
		_, key, _ := st.VersionPage(ctx, "alice", page, 1)
		if err := st.Archive(ctx, "alice", KindPage, page); err != nil {
			t.Fatal(err)
		}
		if _, err := st.BundleFile(ctx, key, "assets/app.js"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("archived: %v, want ErrNotFound", err)
		}
		if err := st.Unarchive(ctx, "alice", KindPage, page); err != nil {
			t.Fatal(err)
		}
		if _, err := st.BundleFile(ctx, key, "assets/app.js"); err != nil {
			t.Fatalf("unarchived: %v", err)
		}
	})
}

func TestSweepBundleBlobs(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()

	put := func(content string) string {
		t.Helper()
		f := file("x", content)
		if _, err := pool.Exec(ctx, `INSERT INTO bundle_blob (sha256, size_bytes, content, created_at) VALUES ($1, $2, $3, now() - interval '2 days')`,
			f.SHA256, f.Size, []byte(content)); err != nil {
			t.Fatal(err)
		}
		return f.SHA256
	}
	// Used by a version.
	token, _, _ := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "App", Bundle: true}, BundleGrantTTL)
	uploadBundle(t, st, token, bundle{"index.html": "<p>app</p>", "used.js": "used"}, "")
	if _, err := pool.Exec(ctx, `UPDATE bundle_blob SET created_at = now() - interval '2 days'`); err != nil {
		t.Fatal(err)
	}
	used := file("x", "used").SHA256
	// index.html lives in the version's content, so its blob is unused.
	index := file("x", "<p>app</p>").SHA256
	// Named by the manifest of a live grant.
	pending, _, _ := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "Later", Bundle: true}, BundleGrantTTL)
	if _, err := st.SetBundleManifest(ctx, pending, bundle{"index.html": "<p>later</p>", "pending.js": "pending"}.manifest()); err != nil {
		t.Fatal(err)
	}
	pendingBlob := put("pending")
	// Named by an expired grant's manifest only: unused.
	expired, _, _ := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "Old", Bundle: true}, BundleGrantTTL)
	if _, err := st.SetBundleManifest(ctx, expired, bundle{"index.html": "<p>old</p>", "old.js": "old"}.manifest()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE asset_grant SET expires_at = now() - interval '1 hour' WHERE secret_hash = $1`, hashToken(expired)); err != nil {
		t.Fatal(err)
	}
	oldBlob := put("old")
	orphan := put("orphan")
	// Recent and unused: kept for now.
	f := file("x", "recent")
	if _, err := pool.Exec(ctx, `INSERT INTO bundle_blob (sha256, size_bytes, content) VALUES ($1, $2, $3)`, f.SHA256, f.Size, []byte("recent")); err != nil {
		t.Fatal(err)
	}

	n, err := st.SweepBundleBlobs(ctx, 24*time.Hour)
	if err != nil || n != 3 {
		t.Fatalf("sweep = %d, %v; want 3", n, err)
	}
	for sum, want := range map[string]bool{used: true, pendingBlob: true, f.SHA256: true, oldBlob: false, orphan: false, index: false} {
		var exists bool
		_ = pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM bundle_blob WHERE sha256 = $1)`, sum).Scan(&exists)
		if exists != want {
			t.Errorf("blob %s… exists = %v, want %v", sum[:8], exists, want)
		}
	}
}

// countingReader counts the bytes read from it, and is endless.
type countingReader struct{ n int64 }

func (r *countingReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	r.n += int64(len(p))
	return len(p), nil
}

func TestBundleBlobSizesAndClaims(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	mint := func(name string) string {
		t.Helper()
		token, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: name, Bundle: true}, BundleGrantTTL)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}
	var invalid *ErrInvalid

	t.Run("body is read only after the checks, and only up to its size", func(t *testing.T) {
		var r countingReader
		if err := st.PutBundleBlob(ctx, "nope", file("x", "x").SHA256, &r); !errors.Is(err, ErrNotFound) || r.n != 0 {
			t.Fatalf("unknown token: %v after reading %d bytes", err, r.n)
		}
		token := mint("Reads")
		b := bundle{"index.html": "<p>reads</p>", "a.txt": "aaaa"}
		if _, err := st.SetBundleManifest(ctx, token, b.manifest()); err != nil {
			t.Fatal(err)
		}
		if err := st.PutBundleBlob(ctx, token, file("x", "other").SHA256, &r); !errors.As(err, &invalid) || r.n != 0 {
			t.Fatalf("unknown hash: %v after reading %d bytes", err, r.n)
		}
		if err := st.PutBundleBlob(ctx, token, file("a.txt", "aaaa").SHA256, io.LimitReader(&r, 1<<20)); !errors.As(err, &invalid) || r.n > 1<<16 {
			t.Fatalf("endless body: %v after reading %d bytes", err, r.n)
		}
		if err := st.PutBundleBlob(ctx, token, file("a.txt", "aaaa").SHA256, strings.NewReader("aaa")); !errors.As(err, &invalid) {
			t.Fatalf("short body: %v, want ErrInvalid", err)
		}
	})

	t.Run("a manifest size must match the stored blob", func(t *testing.T) {
		uploadBundle(t, st, mint("First"), bundle{"index.html": "<p>first</p>", "shared.js": "shared"}, "")
		token := mint("Liar")
		lie := bundle{"index.html": "<p>liar</p>", "shared.js": "shared"}.manifest()
		for i := range lie {
			if lie[i].Path == "shared.js" {
				lie[i].Size = 1
			}
		}
		if _, err := st.SetBundleManifest(ctx, token, lie); !errors.As(err, &invalid) {
			t.Fatalf("manifest with a wrong size for a known blob: %v, want ErrInvalid", err)
		}
	})

	t.Run("a commit checks sizes against blobs uploaded meanwhile", func(t *testing.T) {
		token := mint("Racer")
		lie := bundle{"index.html": "<p>racer</p>", "late.js": "uploaded by someone else"}.manifest()
		for i := range lie {
			if lie[i].Path == "late.js" {
				lie[i].Size = 3
			}
		}
		missing, err := st.SetBundleManifest(ctx, token, lie)
		if err != nil || len(missing) != 2 {
			t.Fatalf("manifest: %v, %v", missing, err)
		}
		if err := st.PutBundleBlob(ctx, token, file("index.html", "<p>racer</p>").SHA256, strings.NewReader("<p>racer</p>")); err != nil {
			t.Fatal(err)
		}
		// Another upload stores the real blob.
		uploadBundle(t, st, mint("Other"), bundle{"index.html": "<p>other</p>", "late.js": "uploaded by someone else"}, "")
		if _, _, err := st.CommitBundle(ctx, token, "", true); !errors.As(err, &invalid) {
			t.Fatalf("commit: %v, want ErrInvalid", err)
		}
	})

	t.Run("only blobs the uploader can vouch for are skipped", func(t *testing.T) {
		secret := "bob's secret file"
		bobs, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "bob", Name: "Bob's", Bundle: true}, BundleGrantTTL)
		if err != nil {
			t.Fatal(err)
		}
		bobsPage, _ := uploadBundle(t, st, bobs, bundle{"index.html": "<p>bob</p>", "secret.json": secret}, "")
		s := file("x", secret).SHA256

		// Alice can't see bob's page: the blob is missing for her, whether
		// it exists or not, and she can't commit without sending it.
		token := mint("Guess")
		b := bundle{"index.html": "<p>guess</p>", "guess.json": secret}
		missing, err := st.SetBundleManifest(ctx, token, b.manifest())
		if err != nil || !slices.Contains(missing, s) {
			t.Fatalf("missing = %v, %v; want bob's blob in it", missing, err)
		}
		if err := st.PutBundleBlob(ctx, token, file("x", "<p>guess</p>").SHA256, strings.NewReader("<p>guess</p>")); err != nil {
			t.Fatal(err)
		}
		var mb *ErrMissingBlobs
		if _, _, err := st.CommitBundle(ctx, token, "", true); !errors.As(err, &mb) || !slices.Equal(mb.Missing, []string{s}) {
			t.Fatalf("commit without sending it: %v, want it missing", err)
		}
		// Sending the bytes proves she has them.
		if err := st.PutBundleBlob(ctx, token, s, strings.NewReader(secret)); err != nil {
			t.Fatal(err)
		}
		if _, _, err := st.CommitBundle(ctx, token, "", true); err != nil {
			t.Fatalf("commit after sending it: %v", err)
		}

		// Once bob shares his page, alice's uploads can reuse its blobs.
		if err := st.Share(ctx, "bob", KindPage, bobsPage, "alice", RoleViewer); err != nil {
			t.Fatal(err)
		}
		token = mint("Reuse")
		if missing, err := st.SetBundleManifest(ctx, token, bundle{"index.html": "<p>reuse</p>", "s.json": secret}.manifest()); err != nil || slices.Contains(missing, s) {
			t.Fatalf("missing = %v, %v; want bob's shared blob known", missing, err)
		}
	})
}
