package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/danieles/specola/internal/backend"

	"github.com/jackc/pgx/v5"
)

// Page backends (docs/page-backends.md): a bundle version may carry server
// code, which the runner runs. asset_version.backend is its manifest
// (non-null marks a backend version) and backend_hash identifies its code.
//
// A backend page's data is one live state, so only its current version is
// live: a version can be opened only if it is the current one, or if neither
// it nor the current version has a backend. The others stay in the history,
// readable and restorable, but are not served.

// ErrSuperseded means a version can't be opened: its page has a backend, or
// it has one itself, and it isn't the current version.
var ErrSuperseded = errors.New("this page has a backend: only its current version can be opened")

// ErrBackendDisabled means a bundle with a backend reached an instance that
// doesn't run page backends.
var ErrBackendDisabled = errors.New("this bundle has a backend (.specola/backend.json), but page backends are not enabled on this Specola instance: it has no backend runner. " +
	"Publish the app without its server code, or ask the instance's operator to enable backends.")

// ErrBackendPinned means a public link can't be pinned to a version of a
// backend page: it always follows the current one.
var ErrBackendPinned = errors.New("this page has a backend: its public links follow the current version and can't be pinned to one")

// viewable is the SQL for "version v of page a can be opened", where cur is
// a's current version.
const viewable = `(v.version = a.current_version OR (v.backend IS NULL AND cur.backend IS NULL))`

// ServedVersion is a version to serve.
type ServedVersion struct {
	HTML string
	// BundleKey is the bundle's key, "" for a plain page.
	BundleKey string
	// Backend: the version has a backend; PageBackend: the page's current
	// version has one.
	Backend, PageBackend bool
}

// servedVersion reads version n of page id for serving, or ErrSuperseded
// when it can't be opened. It doesn't check access.
func servedVersion(ctx context.Context, q querier, id string, n int) (*ServedVersion, error) {
	var (
		sv  ServedVersion
		key *string
		ok  bool
	)
	err := q.QueryRow(ctx, `
		SELECT v.content, v.bundle_key, v.backend IS NOT NULL, cur.backend IS NOT NULL, `+viewable+`
		FROM asset a
		JOIN asset_version v ON v.asset_id = a.id
		JOIN asset_version cur ON cur.asset_id = a.id AND cur.version = a.current_version
		WHERE a.id = $1::uuid AND v.version = $2`, id, n).Scan(&sv.HTML, &key, &sv.Backend, &sv.PageBackend, &ok)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrSuperseded
	}
	if key != nil {
		sv.BundleKey = *key
	}
	return &sv, nil
}

// ServeVersion returns version n of a page sub can see, to serve it, or
// ErrSuperseded when that version can't be opened.
func (s *Store) ServeVersion(ctx context.Context, sub, id string, n int) (*ServedVersion, error) {
	if err := checkPage(ctx, s.pool, id, sub, RoleViewer); err != nil {
		return nil, err
	}
	return servedVersion(ctx, s.pool, id, n)
}

// BackendTarget is what a call to a page's backend needs to know: the
// caller's role and identity, and the page's current version.
type BackendTarget struct {
	Role      Role
	User      backend.User
	Title     string
	Version   int
	VersionID string
	// CodeHash is "" and Manifest nil when the current version has no
	// backend.
	CodeHash string
	Manifest *backend.Manifest
}

// BackendTarget describes a call by sub to the backend of page id, which sub
// must be able to see (ErrNotFound otherwise, archived pages included).
func (s *Store) BackendTarget(ctx context.Context, sub, id string) (*BackendTarget, error) {
	t := BackendTarget{User: backend.User{Sub: sub}}
	var (
		hash     *string
		manifest []byte
	)
	err := s.pool.QueryRow(ctx, `
		SELECT r.level, a.name, a.current_version, v.id::text, v.backend_hash, v.backend,
		       COALESCE(u.email, ''), COALESCE(u.name, '')
		FROM asset a
		CROSS JOIN LATERAL (SELECT asset_access($2, a.id) AS level) r
		JOIN asset_version v ON v.asset_id = a.id AND v.version = a.current_version
		LEFT JOIN app_user u ON u.sub = $2
		WHERE a.id = $1::uuid AND a.deleted_at IS NULL AND a.archived_at IS NULL`, id, sub).
		Scan(&t.Role, &t.Title, &t.Version, &t.VersionID, &hash, &manifest, &t.User.Email, &t.User.Name)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := need(t.Role, RoleViewer); err != nil {
		return nil, err
	}
	if manifest != nil {
		t.Manifest = &backend.Manifest{}
		if err := json.Unmarshal(manifest, t.Manifest); err != nil {
			return nil, err
		}
		if hash != nil {
			t.CodeHash = *hash
		}
	}
	return &t, nil
}

// CodeFile is one file of a backend's code, its path relative to .specola/.
type CodeFile struct {
	Path    string `json:"path"`
	Content []byte `json:"content"`
}

// BackendCode returns the code of the backend version with row id versionID
// (every file under .specola/) and its hash, for the runner. No user is
// involved: only the runner may ask. A version without a backend, or an
// unknown one, is ErrNotFound.
func (s *Store) BackendCode(ctx context.Context, versionID string) (codeHash string, files []CodeFile, err error) {
	var hash *string
	err = s.pool.QueryRow(ctx, `SELECT backend_hash FROM asset_version WHERE id = $1::uuid AND backend IS NOT NULL`, versionID).Scan(&hash)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return "", nil, ErrNotFound
	}
	if err != nil {
		return "", nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT substr(f.path, $2), b.content
		FROM asset_version_file f JOIN bundle_blob b ON b.sha256 = f.sha256
		WHERE f.asset_version_id = $1::uuid AND starts_with(f.path, $3)
		ORDER BY f.path`, versionID, len(backend.Prefix)+1, backend.Prefix)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	files = []CodeFile{}
	for rows.Next() {
		var f CodeFile
		if err := rows.Scan(&f.Path, &f.Content); err != nil {
			return "", nil, err
		}
		files = append(files, f)
	}
	if hash != nil {
		codeHash = *hash
	}
	return codeHash, files, rows.Err()
}
