package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/testdb"
)

// backendApp is a bundle with a backend.
var backendApp = bundle{
	"index.html":                `<p>app</p>`,
	"assets/app.js":             `console.log(1)`,
	".specola/backend.json":     `{"version":1,"egress":["API.example.com"],"cron":[{"name":"n","schedule":"0 3 * * *"}]}`,
	".specola/server/index.mjs": `export default { fetch() { return new Response("hi") } }`,
}

func TestBackendLayout(t *testing.T) {
	index := file("index.html", "<p>x</p>")
	if err := ValidateManifest([]BundleFile{index, file(".specola/server/index.mjs", "x")}); err == nil ||
		!strings.Contains(err.Error(), ".specola/backend.json") {
		t.Fatalf("code without backend.json: %v", err)
	}
	big := file(".specola/backend.json", "{}")
	big.Size = backend.MaxManifestBytes + 1
	if err := ValidateManifest([]BundleFile{index, big}); err == nil {
		t.Fatal("a huge backend.json was accepted")
	}
	if err := ValidateManifest(backendApp.manifest()); err != nil {
		t.Fatalf("backend app: %v", err)
	}
	if !HasBackend(backendApp.manifest()) || HasBackend([]BundleFile{index}) {
		t.Fatal("HasBackend")
	}
}

func TestBackendVersions(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	mint := func(req GrantRequest) string {
		t.Helper()
		req.Bundle = true
		token, _, err := st.MintGrant(ctx, req, BundleGrantTTL)
		if err != nil {
			t.Fatal(err)
		}
		return token
	}

	// v1 static, v2 static, v3 with a backend.
	page, _, err := st.CreatePage(ctx, nil, "App", "<p>one</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AddVersion(ctx, page, "<p>two</p>", "", "alice"); err != nil {
		t.Fatal(err)
	}
	viewable := func(want ...bool) {
		t.Helper()
		vs, err := st.Versions(ctx, "alice", page)
		if err != nil {
			t.Fatal(err)
		}
		if len(vs) != len(want) {
			t.Fatalf("%d versions, want %d", len(vs), len(want))
		}
		for i, v := range vs { // newest first
			if v.Viewable != want[len(want)-1-i] {
				t.Errorf("v%d viewable = %v, want %v", v.Version, v.Viewable, !v.Viewable)
			}
			_, err := st.ServeVersion(ctx, "alice", page, v.Version)
			if v.Viewable != (err == nil) || (!v.Viewable && !errors.Is(err, ErrSuperseded)) {
				t.Errorf("ServeVersion(v%d) = %v with viewable %v", v.Version, err, v.Viewable)
			}
		}
	}
	viewable(true, true)

	// A pinned link on a static page is fine, until the page gets a backend.
	pinned, _, err := st.CreatePublicLink(ctx, "alice", page, PublicLinkRequest{Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	following, _, err := st.CreatePublicLink(ctx, "alice", page, PublicLinkRequest{})
	if err != nil {
		t.Fatal(err)
	}

	_, v3 := uploadBundle(t, st, mint(GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: page}), backendApp, "")
	if v3 != 3 {
		t.Fatalf("version %d", v3)
	}
	viewable(false, false, true)
	vs, _ := st.Versions(ctx, "alice", page)
	if !vs[0].Backend || !vs[0].Bundle || vs[1].Backend {
		t.Fatalf("versions = %+v", vs)
	}
	meta, err := st.PageMeta(ctx, "alice", page)
	if err != nil || !meta.Backend || !meta.Bundle {
		t.Fatalf("meta = %+v, %v", meta, err)
	}
	sv, err := st.ServeVersion(ctx, "alice", page, 3)
	if err != nil || !sv.Backend || !sv.PageBackend || sv.BundleKey == "" {
		t.Fatalf("serve v3 = %+v, %v", sv, err)
	}

	// The stored manifest is normalised, and the hash is of the code.
	var stored, hash string
	if err := pool.QueryRow(ctx, `SELECT backend::text, backend_hash FROM asset_version WHERE asset_id = $1::uuid AND version = 3`, page).
		Scan(&stored, &hash); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stored, `"egress": ["api.example.com"]`) || !strings.Contains(stored, `"entry": "server/index.mjs"`) ||
		!strings.Contains(stored, `"secrets": []`) {
		t.Fatalf("stored manifest = %s", stored)
	}
	line := func(p string) string {
		s := sha256.Sum256([]byte(backendApp[".specola/"+p]))
		return p + "\t" + hex.EncodeToString(s[:]) + "\n"
	}
	want := sha256.Sum256([]byte(line("backend.json") + line("server/index.mjs")))
	if hash != hex.EncodeToString(want[:]) {
		t.Fatalf("backend_hash = %s", hash)
	}

	// Public links: a pinned one is closed now, one following the current
	// version works, and no new one can be pinned.
	if _, err := st.OpenPublicLink(ctx, pinned); !errors.Is(err, ErrSuperseded) {
		t.Fatalf("pinned link: %v, want ErrSuperseded", err)
	}
	if sv, err := st.OpenPublicLink(ctx, following); err != nil || !sv.Backend {
		t.Fatalf("following link = %+v, %v", sv, err)
	}
	if _, _, err := st.CreatePublicLink(ctx, "alice", page, PublicLinkRequest{Version: 3}); !errors.Is(err, ErrBackendPinned) {
		t.Fatalf("pin a backend page: %v, want ErrBackendPinned", err)
	}

	// The backend's files are for the runner only.
	key, files, err := st.VersionFiles(ctx, "alice", page, 3)
	if err != nil || len(files) != 1 || files[0].Path != "assets/app.js" {
		t.Fatalf("files = %+v, %v", files, err)
	}
	if _, err := st.BundleFileInfo(ctx, key, ".specola/server/index.mjs"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("serve backend code: %v, want ErrNotFound", err)
	}
	if _, err := st.BundleFileInfo(ctx, key, "assets/app.js"); err != nil {
		t.Fatal(err)
	}
	target, err := st.BackendTarget(ctx, "alice", page)
	if err != nil || target.Role != RoleOwner || target.Version != 3 || target.CodeHash != hash ||
		target.Manifest == nil || target.Manifest.Egress[0] != "api.example.com" || target.Title != "App" {
		t.Fatalf("target = %+v, %v", target, err)
	}
	if target.ID != page {
		t.Fatalf("target.ID = %q, want %q", target.ID, page)
	}
	// Other spellings of the same uuid name the same page, by its one id.
	for _, spelling := range []string{strings.ToUpper(page), strings.ReplaceAll(page, "-", "")} {
		if alt, err := st.BackendTarget(ctx, "alice", spelling); err != nil || alt.ID != page {
			t.Fatalf("BackendTarget(%q) = %+v, %v; want ID %q", spelling, alt, err, page)
		}
	}
	if _, err := st.BackendTarget(ctx, "bob", page); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bob's target: %v, want ErrNotFound", err)
	}
	codeHash, code, err := st.BackendCode(ctx, target.VersionID)
	if err != nil || codeHash != hash || len(code) != 2 || code[0].Path != "backend.json" || code[1].Path != "server/index.mjs" ||
		string(code[1].Content) != backendApp[".specola/server/index.mjs"] {
		t.Fatalf("code = %s %+v, %v", codeHash, code, err)
	}

	// Restore: the old static version becomes current, so the backend
	// version is the closed one; restoring the backend version brings its
	// backend back.
	if v, err := st.RestoreVersion(ctx, "alice", page, 2, ""); err != nil || v != 4 {
		t.Fatalf("restore v2: %d, %v", v, err)
	}
	viewable(true, true, false, true)
	if _, err := st.OpenPublicLink(ctx, pinned); err != nil {
		t.Fatalf("pinned link once the page is static again: %v", err)
	}
	// v3, with a backend, is closed now: no link can be pinned to it.
	if _, _, err := st.CreatePublicLink(ctx, "alice", page, PublicLinkRequest{Version: 3}); !errors.Is(err, ErrBackendPinned) {
		t.Fatalf("pin a closed backend version: %v, want ErrBackendPinned", err)
	}
	if _, _, err := st.CreatePublicLink(ctx, "alice", page, PublicLinkRequest{Version: 2}); err != nil {
		t.Fatalf("pin a static version of a static page: %v", err)
	}
	if _, _, err := st.BackendCode(ctx, mustVersionID(t, st, page, 4)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("code of a static version: %v", err)
	}
	if v, err := st.RestoreVersion(ctx, "alice", page, 3, ""); err != nil || v != 5 {
		t.Fatalf("restore v3: %d, %v", v, err)
	}
	viewable(false, false, false, false, true)
	if target, err := st.BackendTarget(ctx, "alice", page); err != nil || target.Version != 5 || target.CodeHash != hash {
		t.Fatalf("target after restore = %+v, %v", target, err)
	}
	if _, _, err := st.BackendCode(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("malformed version id: %v", err)
	}
}

func TestBackendManifestChecksAtCommit(t *testing.T) {
	st := New(testdb.New(t))
	ctx := context.Background()
	for name, tc := range map[string]struct {
		manifest, want string
	}{
		"invalid json":  {`{`, "not a valid manifest"},
		"missing entry": {`{"version":1,"entry":"server/main.mjs"}`, `"entry"`},
		"bad cron":      {`{"version":1,"cron":[{"name":"x","schedule":"* * *"}]}`, `"cron"[0].schedule`},
	} {
		b := bundle{"index.html": "<p>x</p>", ".specola/backend.json": tc.manifest, ".specola/server/index.mjs": "x"}
		token, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: name, Bundle: true}, BundleGrantTTL)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := st.SetBundleManifest(ctx, token, b.manifest()); err != nil {
			t.Fatal(err)
		}
		for _, f := range b.manifest() {
			if err := st.PutBundleBlob(ctx, token, f.SHA256, strings.NewReader(b[f.Path])); err != nil {
				t.Fatal(err)
			}
		}
		_, _, err = st.CommitBundle(ctx, token, "", true)
		var invalid *ErrInvalid
		if !errors.As(err, &invalid) || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: commit = %v, want ErrInvalid naming %s", name, err, tc.want)
		}
	}
}

func mustVersionID(t *testing.T, st *Store, page string, v int) string {
	t.Helper()
	var id string
	if err := st.pool.QueryRow(context.Background(), `SELECT id::text FROM asset_version WHERE asset_id = $1::uuid AND version = $2`, page, v).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// A manifest posted while backends were enabled, committed after they were
// turned off, is still refused.
func TestBackendCommitWhenDisabled(t *testing.T) {
	st := New(testdb.New(t))
	ctx := context.Background()
	b := bundle{"index.html": "<p>x</p>", ".specola/backend.json": `{"version":1}`, ".specola/server/index.mjs": "x"}
	token, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "off", Bundle: true}, BundleGrantTTL)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetBundleManifest(ctx, token, b.manifest()); err != nil {
		t.Fatal(err)
	}
	for _, f := range b.manifest() {
		if err := st.PutBundleBlob(ctx, token, f.SHA256, strings.NewReader(b[f.Path])); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := st.CommitBundle(ctx, token, "", false); !errors.Is(err, ErrBackendDisabled) {
		t.Fatalf("commit with backends off = %v, want ErrBackendDisabled", err)
	}
	// The grant is not consumed: the same upload commits once they are back.
	if _, _, err := st.CommitBundle(ctx, token, "", true); err != nil {
		t.Fatalf("commit with backends on: %v", err)
	}
}
