package store

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// SPA bundles (docs/spa-bundles.md): a version whose index.html is stored as
// its content, like a plain page, and whose other files are content-addressed
// blobs shared by every version and page. A bundle is uploaded file by file
// through a bundle upload grant: the client posts a manifest, puts the blobs
// the server doesn't have, then commits. bundle_key, random per version, is
// the capability in the URLs the files are served at.

// Bundle limits, reported to the CLI before it builds.
const (
	MaxBundleFiles     = 2000      // files per bundle, index.html included
	MaxBundleFileBytes = 25 << 20  // one file
	MaxBundleIndexSize = 5 << 20   // index.html
	MaxBundleBytes     = 100 << 20 // the whole bundle
	MaxBundlePathBytes = 512       // one path
	// BundleGrantTTL is how long a bundle upload grant is valid: long enough
	// to build and upload a large app over a slow link.
	BundleGrantTTL = 30 * time.Minute
	// BundleIndex is the bundle's entry document, stored as the version's
	// content.
	BundleIndex = "index.html"
)

// BundleFile is one entry of a bundle manifest, as the client sends it.
type BundleFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// VersionFile is one file of a bundle version (index.html aside).
type VersionFile struct {
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
	SHA256      string `json:"sha256"`
}

// ErrMissingBlobs means a bundle can't be committed until these blobs are
// uploaded.
type ErrMissingBlobs struct{ Missing []string }

func (e *ErrMissingBlobs) Error() string {
	return fmt.Sprintf("%d files of the manifest are not uploaded yet", len(e.Missing))
}

// ValidateBundlePath checks one path of a bundle against the rules in "Paths
// in a bundle": relative, '/'-separated, no empty, "." or ".." segments, and
// none of the characters that would change its meaning in a URL.
func ValidateBundlePath(p string) error {
	bad := func(why string) error { return &ErrInvalid{fmt.Sprintf("invalid path %q: %s", p, why)} }
	switch {
	case p == "":
		return &ErrInvalid{"invalid path: empty"}
	case len(p) > MaxBundlePathBytes:
		return bad(fmt.Sprintf("longer than %d bytes", MaxBundlePathBytes))
	case !utf8.ValidString(p):
		return bad("not valid UTF-8")
	case strings.HasPrefix(p, "/"):
		return bad("must be relative")
	}
	for _, r := range p {
		if unicode.IsControl(r) || strings.ContainsRune(`\?#%`, r) {
			return bad(`contains a control character or one of \ ? # %`)
		}
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return bad(`has an empty, "." or ".." segment`)
		}
	}
	if isHTML(p) && p != BundleIndex {
		return bad("the only HTML file allowed is index.html at the root")
	}
	return nil
}

func isHTML(p string) bool {
	ext := strings.ToLower(path.Ext(p))
	return ext == ".html" || ext == ".htm"
}

// ValidateManifest checks every path and the limits of a bundle manifest.
func ValidateManifest(files []BundleFile) error {
	if len(files) > MaxBundleFiles {
		return &ErrInvalid{fmt.Sprintf("a bundle can have at most %d files, this one has %d", MaxBundleFiles, len(files))}
	}
	seen := make(map[string]bool, len(files))
	sizes := make(map[string]int64, len(files))
	var total int64
	hasIndex := false
	for _, f := range files {
		if err := ValidateBundlePath(f.Path); err != nil {
			return err
		}
		if seen[f.Path] {
			return &ErrInvalid{fmt.Sprintf("path %q is listed twice", f.Path)}
		}
		seen[f.Path] = true
		if !validSHA256(f.SHA256) {
			return &ErrInvalid{fmt.Sprintf("%s: sha256 must be 64 lowercase hex characters", f.Path)}
		}
		if f.Size < 0 || f.Size > MaxBundleFileBytes {
			return &ErrInvalid{fmt.Sprintf("%s: a file can be at most %d bytes", f.Path, MaxBundleFileBytes)}
		}
		if n, ok := sizes[f.SHA256]; ok && n != f.Size {
			return &ErrInvalid{fmt.Sprintf("%s: same sha256 as another file but a different size", f.Path)}
		}
		sizes[f.SHA256] = f.Size
		if f.Path == BundleIndex {
			hasIndex = true
			if f.Size > MaxBundleIndexSize {
				return &ErrInvalid{fmt.Sprintf("index.html can be at most %d bytes", MaxBundleIndexSize)}
			}
		}
		total += f.Size
	}
	if !hasIndex {
		return &ErrInvalid{"a bundle needs an index.html at its root"}
	}
	if total > MaxBundleBytes {
		return &ErrInvalid{fmt.Sprintf("a bundle can be at most %d bytes in all, this one is %d", MaxBundleBytes, total)}
	}
	return nil
}

func validSHA256(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !('0' <= c && c <= '9' || 'a' <= c && c <= 'f') {
			return false
		}
	}
	return true
}

// bundleTypes maps a file extension to the Content-Type its file is served
// with. Text types name their charset, since Vite emits UTF-8.
var bundleTypes = map[string]string{
	".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".json": "application/json", ".map": "application/json",
	".wasm": "application/wasm",
	".svg":  "image/svg+xml",
	".png":  "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon", ".bmp": "image/bmp",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
	".txt":         "text/plain; charset=utf-8",
	".csv":         "text/csv; charset=utf-8",
	".xml":         "application/xml",
	".webmanifest": "application/manifest+json",
	".mp3":         "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
	".mp4": "video/mp4", ".webm": "video/webm",
	".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".bin": "application/octet-stream",
}

// BundleContentType is the Content-Type a bundle file is served with, from
// its extension (case-insensitive); unknown ones are octet streams.
func BundleContentType(p string) string {
	if t, ok := bundleTypes[strings.ToLower(path.Ext(p))]; ok {
		return t
	}
	return "application/octet-stream"
}

// BundleUpload describes a bundle upload grant, for the CLI to check before
// building.
type BundleUpload struct {
	Kind      string    `json:"kind"` // "new" | "version"
	Title     string    `json:"title,omitempty"`
	PageID    string    `json:"pageId,omitempty"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// grant is an asset_grant row as the bundle upload steps need it.
type grant struct {
	id, kind, sub     string
	assetID, folderID *string
	name, note        *string
	bundle            bool
	manifest          []byte
	uploaded          []string // sha256 of the blobs uploaded through it
	expiresAt         time.Time
}

// openGrant reads an unused, unexpired grant by token, locking it when lock is
// set. It returns ErrNotFound for an unknown token and ErrGrantGone for a used
// or expired one.
func openGrant(ctx context.Context, q querier, token string, lock bool) (*grant, error) {
	sql := `
		SELECT id::text, kind::text, asset_id::text, folder_id::text, name, created_by_sub, note,
		       bundle, manifest, uploaded, expires_at, consumed_at IS NOT NULL OR expires_at <= now()
		FROM asset_grant
		WHERE secret_hash = $1`
	if lock {
		sql += ` FOR UPDATE`
	}
	var (
		g    grant
		gone bool
	)
	err := q.QueryRow(ctx, sql, hashToken(token)).Scan(&g.id, &g.kind, &g.assetID, &g.folderID, &g.name, &g.sub, &g.note,
		&g.bundle, &g.manifest, &g.uploaded, &g.expiresAt, &gone)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if gone {
		return nil, ErrGrantGone
	}
	return &g, nil
}

// openBundleGrant is openGrant for the bundle upload steps: any other grant
// is ErrGrantKind.
func openBundleGrant(ctx context.Context, q querier, token string, lock bool) (*grant, error) {
	g, err := openGrant(ctx, q, token, lock)
	if err != nil {
		return nil, err
	}
	if !g.bundle || (g.kind != GrantUploadNew && g.kind != GrantUploadVersion) {
		return nil, ErrGrantKind
	}
	return g, nil
}

// manifestFiles decodes the manifest stored on a grant; nil when none was
// posted yet.
func (g *grant) manifestFiles() ([]BundleFile, error) {
	if g.manifest == nil {
		return nil, nil
	}
	var files []BundleFile
	err := json.Unmarshal(g.manifest, &files)
	return files, err
}

// BundleUploadInfo describes the bundle upload grant token names.
func (s *Store) BundleUploadInfo(ctx context.Context, token string) (*BundleUpload, error) {
	g, err := openBundleGrant(ctx, s.pool, token, false)
	if err != nil {
		return nil, err
	}
	u := &BundleUpload{ExpiresAt: g.expiresAt}
	if g.kind == GrantUploadNew {
		u.Kind = "new"
		if g.name != nil {
			u.Title = *g.name
		}
	} else {
		u.Kind = "version"
		if g.assetID != nil {
			u.PageID = *g.assetID
		}
	}
	return u, nil
}

// SetBundleManifest validates files and stores them as the grant's manifest,
// replacing any earlier one. It returns the sha256 of the blobs the upload
// still has to send, sorted and without duplicates: all but those the server
// can vouch the uploader has (see knownBlobs).
//
// An unknown, used or expired token is reported before an invalid manifest.
func (s *Store) SetBundleManifest(ctx context.Context, token string, files []BundleFile) (missing []string, err error) {
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		g, err := openBundleGrant(ctx, tx, token, true)
		if err != nil {
			return err
		}
		if err := ValidateManifest(files); err != nil {
			return err
		}
		doc, err := json.Marshal(files)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE asset_grant SET manifest = $2 WHERE id = $1::uuid`, g.id, doc); err != nil {
			return err
		}
		have, err := knownBlobs(ctx, tx, g, distinctSums(files), false)
		if err != nil {
			return err
		}
		missing, err = missingBlobs(files, have)
		return err
	})
	return missing, err
}

// knownBlobs returns the size of each of sums that the grant's upload may use
// without sending its bytes: blobs uploaded through this grant, and blobs of
// bundle versions the grant's user can see. Blobs are shared by every page,
// but which ones exist is not told to anyone else: otherwise anyone could
// learn whether some content was uploaded anywhere (guessing it, hash by
// hash), and include a file they only know the sha256 of in their own
// bundle, then read it. A blob a version uses is never swept, and one
// uploaded through the grant is protected by its manifest.
//
// lock takes a key-share lock on the blobs, so that the sweep can't delete
// them before the transaction references them.
func knownBlobs(ctx context.Context, q querier, g *grant, sums []string, lock bool) (map[string]int64, error) {
	sql := `
		SELECT b.sha256, b.size_bytes FROM bundle_blob b
		WHERE b.sha256 = ANY($1)
		  AND (b.sha256 = ANY($2) OR EXISTS (
		    SELECT 1 FROM asset_version_file f
		    JOIN asset_version v ON v.id = f.asset_version_id
		    JOIN asset a ON a.id = v.asset_id
		    WHERE f.sha256 = b.sha256 AND a.deleted_at IS NULL AND asset_access($3, a.id) > 0))`
	if lock {
		sql += ` FOR KEY SHARE OF b`
	}
	rows, err := q.Query(ctx, sql, sums, g.uploaded, g.sub)
	if err != nil {
		return nil, err
	}
	return scanBlobSizes(rows)
}

func scanBlobSizes(rows pgx.Rows) (map[string]int64, error) {
	defer rows.Close()
	have := map[string]int64{}
	for rows.Next() {
		var (
			h string
			n int64
		)
		if err := rows.Scan(&h, &n); err != nil {
			return nil, err
		}
		have[h] = n
	}
	return have, rows.Err()
}

// distinctSums returns the sorted, distinct sha256 of files.
func distinctSums(files []BundleFile) []string {
	sums := make([]string, 0, len(files))
	for _, f := range files {
		sums = append(sums, f.SHA256)
	}
	slices.Sort(sums)
	return slices.Compact(sums)
}

// missingBlobs returns the sorted, distinct sha256 of files that are not in
// have (sha256 → size). A file whose blob is there with another size is
// invalid: its manifest entry is wrong, and trusting it would misreport the
// file's size and let a bundle exceed its limits.
func missingBlobs(files []BundleFile, have map[string]int64) ([]string, error) {
	missing := []string{}
	for _, f := range files {
		n, ok := have[f.SHA256]
		switch {
		case !ok:
			missing = append(missing, f.SHA256)
		case n != f.Size:
			return nil, &ErrInvalid{fmt.Sprintf("%s: the manifest says %d bytes, but the file with this sha256 has %d", f.Path, f.Size, n)}
		}
	}
	slices.Sort(missing)
	return slices.Compact(missing), nil
}

// PutBundleBlob stores one file's bytes, read from body, for a bundle
// upload. sum must be the sha256 of a file in the grant's manifest, and body
// must have that hash and that file's size. The grant and the manifest are
// checked before body is read, and no more than the file's size (plus one
// byte, to detect a longer body) is read, so an unknown token or hash costs
// no memory. A read error from body is returned as is (wrapped). Storing a
// blob that is already there only records it as uploaded by the grant.
func (s *Store) PutBundleBlob(ctx context.Context, token, sum string, body io.Reader) error {
	g, err := openBundleGrant(ctx, s.pool, token, false)
	if err != nil {
		return err
	}
	files, err := g.manifestFiles()
	if err != nil {
		return err
	}
	if files == nil {
		return &ErrInvalid{"post the manifest before uploading files"}
	}
	i := slices.IndexFunc(files, func(f BundleFile) bool { return f.SHA256 == sum })
	if i < 0 {
		return &ErrInvalid{"this sha256 is not in the manifest"}
	}
	want := files[i].Size
	content, err := io.ReadAll(io.LimitReader(body, want+1))
	if err != nil {
		return fmt.Errorf("read body: %w", err)
	}
	if int64(len(content)) != want {
		if int64(len(content)) > want {
			return &ErrInvalid{fmt.Sprintf("body is longer than the %d bytes the manifest says", want)}
		}
		return &ErrInvalid{fmt.Sprintf("body is %d bytes, the manifest says %d", len(content), want)}
	}
	got := sha256.Sum256(content)
	if hex.EncodeToString(got[:]) != sum {
		return &ErrInvalid{"body does not match its sha256"}
	}
	// The grant records the upload, which lets the commit use the blob. Its
	// row is locked first, as the commit does, so the two can't deadlock. A
	// blob that is already there is claimed: its created_at is reset, so a
	// sweep deleting it right now rechecks it and leaves it (or, having
	// deleted it, lets this insert it again).
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `
			UPDATE asset_grant SET uploaded = array_append(uploaded, $2)
			WHERE id = $1::uuid AND NOT $2 = ANY(uploaded)`, g.id, sum); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO bundle_blob (sha256, size_bytes, content) VALUES ($1, $2, $3)
			ON CONFLICT (sha256) DO UPDATE SET created_at = now()`, sum, len(content), content)
		return err
	})
}

// CommitBundle turns a bundle upload into a page or a new version, as the
// minting user, whose access is checked again. note, when not empty,
// replaces the grant's. Every blob of the manifest must have been uploaded,
// else it returns *ErrMissingBlobs. Everything happens in one transaction,
// which also consumes the grant.
func (s *Store) CommitBundle(ctx context.Context, token, note string) (id string, version int, err error) {
	commitNote, err := CleanNote(note)
	if err != nil {
		return "", 0, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		g, err := openBundleGrant(ctx, tx, token, true)
		if err != nil {
			return err
		}
		if commitNote != nil {
			g.note = commitNote
		}
		// Access first: someone who lost it learns nothing about the upload.
		switch {
		case g.kind == GrantUploadNew && g.name != nil:
			err = checkFolder(ctx, tx, g.folderID, g.sub, RoleEditor)
		case g.kind == GrantUploadVersion && g.assetID != nil:
			err = checkPage(ctx, tx, *g.assetID, g.sub, RoleEditor)
		default:
			err = ErrGrantKind
		}
		if err != nil {
			return err
		}

		files, err := g.manifestFiles()
		if err != nil {
			return err
		}
		if files == nil {
			return &ErrInvalid{"post the manifest before committing"}
		}
		have, err := knownBlobs(ctx, tx, g, distinctSums(files), true)
		if err != nil {
			return err
		}
		missing, err := missingBlobs(files, have)
		if err != nil {
			return err
		}
		if len(missing) > 0 {
			return &ErrMissingBlobs{Missing: missing}
		}

		var html string
		for _, f := range files {
			if f.Path != BundleIndex {
				continue
			}
			var b []byte
			if err := tx.QueryRow(ctx, `SELECT content FROM bundle_blob WHERE sha256 = $1`, f.SHA256).Scan(&b); err != nil {
				return err
			}
			// Postgres text can't hold NUL, and the viewer serves it as UTF-8.
			if !utf8.Valid(b) || bytes.IndexByte(b, 0) >= 0 {
				return &ErrInvalid{"index.html must be valid UTF-8 text"}
			}
			html = string(b)
		}

		if g.kind == GrantUploadNew {
			id, version, err = createPage(ctx, tx, g.folderID, *g.name, html, g.note, g.sub)
		} else {
			id = *g.assetID
			version, err = addVersion(ctx, tx, id, html, g.note, g.sub, nil)
		}
		if err != nil {
			return err
		}
		versionID, err := makeBundle(ctx, tx, id, version)
		if err != nil {
			return err
		}
		var paths, sums, types []string
		var sizes []int64
		for _, f := range files {
			if f.Path == BundleIndex {
				continue
			}
			paths = append(paths, f.Path)
			sums = append(sums, f.SHA256)
			types = append(types, BundleContentType(f.Path))
			sizes = append(sizes, f.Size)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO asset_version_file (asset_version_id, path, sha256, content_type, size_bytes)
			SELECT $1::uuid, p, h, t, n FROM unnest($2::text[], $3::text[], $4::text[], $5::bigint[]) AS f(p, h, t, n)`,
			versionID, paths, sums, types, sizes); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE asset_grant SET consumed_at = now() WHERE id = $1::uuid`, g.id)
		return err
	})
	if err != nil {
		return "", 0, err
	}
	return id, version, nil
}

// makeBundle gives a just-inserted version a new bundle key, marking it as a
// bundle, and returns the version's row id.
func makeBundle(ctx context.Context, tx pgx.Tx, assetID string, version int) (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	var versionID string
	err := tx.QueryRow(ctx, `
		UPDATE asset_version SET bundle_key = $3
		WHERE asset_id = $1::uuid AND version = $2
		RETURNING id::text`, assetID, version, base64.RawURLEncoding.EncodeToString(b)).Scan(&versionID)
	return versionID, err
}

// copyBundleFiles makes version to of a page a bundle with the same files as
// version from, under a new key. Used when restoring a bundle version.
func copyBundleFiles(ctx context.Context, tx pgx.Tx, assetID string, from, to int) error {
	versionID, err := makeBundle(ctx, tx, assetID, to)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO asset_version_file (asset_version_id, path, sha256, content_type, size_bytes)
		SELECT $1::uuid, f.path, f.sha256, f.content_type, f.size_bytes
		FROM asset_version_file f JOIN asset_version v ON v.id = f.asset_version_id
		WHERE v.asset_id = $2::uuid AND v.version = $3`, versionID, assetID, from)
	return err
}

// BundleFileContent is a bundle file to serve.
type BundleFileContent struct {
	SHA256      string
	ContentType string
	Content     []byte
}

// BundleFile returns the file at path of the bundle version with key, as long
// as its page is active (not deleted, nor archived itself or under an
// archived folder). No user is involved: the key is the capability.
func (s *Store) BundleFile(ctx context.Context, key, path string) (*BundleFileContent, error) {
	var f BundleFileContent
	err := s.pool.QueryRow(ctx, `
		SELECT f.sha256, f.content_type, b.content
		FROM asset_version v
		JOIN asset a ON a.id = v.asset_id
		JOIN asset_version_file f ON f.asset_version_id = v.id
		JOIN bundle_blob b ON b.sha256 = f.sha256
		WHERE v.bundle_key = $1 AND f.path = $2
		  AND a.deleted_at IS NULL AND a.archived_at IS NULL
		  AND (a.folder_id IS NULL OR NOT folder_hidden(a.folder_id))`, key, path).
		Scan(&f.SHA256, &f.ContentType, &f.Content)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &f, nil
}

// VersionFiles returns the bundle key and files (index.html aside) of one
// version of a page sub can see. A plain version has key "" and no files.
func (s *Store) VersionFiles(ctx context.Context, sub, id string, version int) (key string, files []VersionFile, err error) {
	if err := checkPage(ctx, s.pool, id, sub, RoleViewer); err != nil {
		return "", nil, err
	}
	var k *string
	err = s.pool.QueryRow(ctx, `SELECT bundle_key FROM asset_version WHERE asset_id = $1::uuid AND version = $2`, id, version).Scan(&k)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}
	files = []VersionFile{}
	if k == nil {
		return "", files, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT f.path, f.size_bytes, f.content_type, f.sha256
		FROM asset_version_file f JOIN asset_version v ON v.id = f.asset_version_id
		WHERE v.bundle_key = $1
		ORDER BY f.path`, *k)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var f VersionFile
		if err := rows.Scan(&f.Path, &f.Size, &f.ContentType, &f.SHA256); err != nil {
			return "", nil, err
		}
		files = append(files, f)
	}
	return *k, files, rows.Err()
}

// SweepBundleBlobs deletes the blobs no bundle version uses, that no unused,
// unexpired bundle grant's manifest names, and that were last uploaded over
// minAge ago, which covers an upload whose grant expired just now. A blob
// uploaded again while the sweep runs is rechecked and kept. A commit that
// references a blob as it is swept makes the sweep fail (foreign key), not
// the commit; the next sweep retries.
func (s *Store) SweepBundleBlobs(ctx context.Context, minAge time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		DELETE FROM bundle_blob b
		WHERE b.created_at < now() - make_interval(secs => $1)
		  AND NOT EXISTS (SELECT 1 FROM asset_version_file f WHERE f.sha256 = b.sha256)
		  AND NOT EXISTS (
		    SELECT 1 FROM asset_grant g
		    WHERE g.bundle AND g.manifest IS NOT NULL AND g.consumed_at IS NULL AND g.expires_at > now()
		      AND g.manifest @> jsonb_build_array(jsonb_build_object('sha256', b.sha256)))`, minAge.Seconds())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
