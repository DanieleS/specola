// Package store holds Specola's data access on top of a pgx connection pool.
// IDs are handled as strings (selected as `id::text`) to keep the layer free of
// UUID codec concerns.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrNotFound = errors.New("not found")

type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// TreeItem is one row in a folder listing: either a sub-folder or a page.
type TreeItem struct {
	ID        string    `json:"id"`
	Kind      string    `json:"kind"` // "folder" | "page"
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	Version   int       `json:"version,omitempty"`
	UpdatedAt time.Time `json:"updatedAt"`
	Role      string    `json:"role"`   // the caller's Role on the item
	Shared    bool      `json:"shared"` // the item itself has shares
	// Favorite: the caller starred the item. Search results leave it unset.
	Favorite bool `json:"favorite,omitempty"`
}

// PageMeta is the metadata the viewer header needs.
type PageMeta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	FolderID  *string   `json:"folderId"`
	Version   int       `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
	Role      string    `json:"role"`
	Shared    bool      `json:"shared"`
	Favorite  bool      `json:"favorite"`
}

// querier is the part of pgxpool.Pool and pgx.Tx the helpers need.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Tree lists the active folders and pages directly under parentID. At the root
// (nil) that is the caller's own items; inside a folder they can see, it is
// everything there, whoever created it.
func (s *Store) Tree(ctx context.Context, sub string, parentID *string) ([]TreeItem, error) {
	if err := checkFolder(ctx, s.pool, parentID, sub, RoleViewer); err != nil {
		return nil, err
	}
	return listItems(ctx, s.pool, `
		SELECT 'folder', f.id::text, f.name, f.slug, 0, f.updated_at, folder_access($2, f.id),
		       EXISTS (SELECT 1 FROM acl_entry e WHERE e.folder_id = f.id), `+favoriteFolder("$2")+`
		FROM folder f
		WHERE f.deleted_at IS NULL AND f.archived_at IS NULL
		  AND f.parent_id IS NOT DISTINCT FROM $1::uuid
		  AND ($1::uuid IS NOT NULL OR f.created_by_sub = $2)
		ORDER BY f.name`, `
		SELECT 'page', a.id::text, a.name, a.slug, a.current_version, a.updated_at, asset_access($2, a.id),
		       EXISTS (SELECT 1 FROM acl_entry e WHERE e.asset_id = a.id), `+favoritePage("$2")+`
		FROM asset a
		WHERE a.deleted_at IS NULL AND a.archived_at IS NULL
		  AND a.folder_id IS NOT DISTINCT FROM $1::uuid
		  AND ($1::uuid IS NOT NULL OR a.created_by_sub = $2)
		ORDER BY a.updated_at DESC`, parentID, sub)
}

// SharedWithMe lists the active folders and pages shared directly with sub.
func (s *Store) SharedWithMe(ctx context.Context, sub string) ([]TreeItem, error) {
	return listItems(ctx, s.pool, `
		SELECT 'folder', f.id::text, f.name, f.slug, 0, f.updated_at, folder_access($1, f.id), true, `+favoriteFolder("$1")+`
		FROM acl_entry e JOIN folder f ON f.id = e.folder_id
		WHERE e.subject_sub = $1 AND f.deleted_at IS NULL AND f.archived_at IS NULL
		ORDER BY f.name`, `
		SELECT 'page', a.id::text, a.name, a.slug, a.current_version, a.updated_at, asset_access($1, a.id), true, `+favoritePage("$1")+`
		FROM acl_entry e JOIN asset a ON a.id = e.asset_id
		WHERE e.subject_sub = $1 AND a.deleted_at IS NULL AND a.archived_at IS NULL
		ORDER BY a.updated_at DESC`, sub)
}

// favoriteFolder and favoritePage are the SQL for "the user in param starred
// folder f / page a", the last column every listItems query selects.
func favoriteFolder(param string) string {
	return `EXISTS (SELECT 1 FROM favorite fv WHERE fv.user_sub = ` + param + ` AND fv.folder_id = f.id)`
}

func favoritePage(param string) string {
	return `EXISTS (SELECT 1 FROM favorite fv WHERE fv.user_sub = ` + param + ` AND fv.asset_id = a.id)`
}

// listItems runs a folder query then a page query with the same arguments,
// each selecting kind, id, name, slug, version, updated_at, role, shared,
// favorite.
func listItems(ctx context.Context, q querier, folders, pages string, args ...any) ([]TreeItem, error) {
	items := []TreeItem{}
	for _, sql := range []string{folders, pages} {
		rows, err := q.Query(ctx, sql, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var it TreeItem
			var r Role
			if err := rows.Scan(&it.Kind, &it.ID, &it.Name, &it.Slug, &it.Version, &it.UpdatedAt, &r, &it.Shared, &it.Favorite); err != nil {
				rows.Close()
				return nil, err
			}
			it.Role = r.String()
			items = append(items, it)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	return items, nil
}

// CreateFolder inserts a folder under parentID (nil = root), retrying the slug
// on collision. sub needs edit access to the parent.
func (s *Store) CreateFolder(ctx context.Context, parentID *string, name, sub string) (string, error) {
	if err := checkFolder(ctx, s.pool, parentID, sub, RoleEditor); err != nil {
		return "", err
	}
	base := slugify(name)
	for i := 0; i < 25; i++ {
		var id string
		err := s.pool.QueryRow(ctx, `
			INSERT INTO folder (parent_id, name, slug, created_by_sub, updated_by_sub)
			VALUES ($1::uuid, $2, $3, $4, $4)
			RETURNING id::text`, parentID, name, withSuffix(base, i), sub).Scan(&id)
		if err == nil {
			return id, nil
		}
		if isUniqueViolation(err) {
			continue
		}
		return "", err
	}
	return "", errors.New("could not allocate a unique folder slug")
}

// CreatePage creates an asset and its version 1 in one transaction. sub needs
// edit access to the folder. note is optional (see CleanNote).
func (s *Store) CreatePage(ctx context.Context, folderID *string, name, html, note, sub string) (id string, version int, err error) {
	n, err := CleanNote(note)
	if err != nil {
		return "", 0, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		id, version, err = createPage(ctx, tx, folderID, name, html, n, sub)
		return err
	})
	return id, version, err
}

// AddVersion appends a new version to a page sub can edit and returns its
// number. note is optional (see CleanNote).
func (s *Store) AddVersion(ctx context.Context, assetID, html, note, sub string) (version int, err error) {
	n, err := CleanNote(note)
	if err != nil {
		return 0, err
	}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		version, err = addVersion(ctx, tx, assetID, html, n, sub, nil)
		return err
	})
	return version, err
}

// MaxNoteRunes bounds a version note: a line or two on what changed, not a
// document.
const MaxNoteRunes = 500

// CleanNote trims a version note; an empty one is stored as NULL.
func CleanNote(note string) (*string, error) {
	note = strings.TrimSpace(note)
	if note == "" {
		return nil, nil
	}
	if utf8.RuneCountInString(note) > MaxNoteRunes {
		return nil, &ErrInvalid{fmt.Sprintf("note is longer than %d characters", MaxNoteRunes)}
	}
	return &note, nil
}

// inTx runs fn in a transaction, committing only if it returns nil.
func (s *Store) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func createPage(ctx context.Context, tx pgx.Tx, folderID *string, name, html string, note *string, sub string) (id string, version int, err error) {
	if err = checkFolder(ctx, tx, folderID, sub, RoleEditor); err != nil {
		return "", 0, err
	}

	base := slugify(name)
	created := false
	for i := 0; i < 25; i++ {
		err = tx.QueryRow(ctx, `
			INSERT INTO asset (folder_id, name, slug, created_by_sub, updated_by_sub, current_version)
			VALUES ($1::uuid, $2, $3, $4, $4, 1)
			ON CONFLICT DO NOTHING
			RETURNING id::text`, folderID, name, withSuffix(base, i), sub).Scan(&id)
		// A unique violation would abort the transaction, so a slug collision
		// is skipped by ON CONFLICT and shows up here as no row.
		if err == nil {
			created = true
			break
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", 0, err
		}
	}
	if !created {
		return "", 0, errors.New("could not allocate a unique page slug")
	}

	if err = insertVersion(ctx, tx, id, 1, html, note, sub, nil); err != nil {
		return "", 0, err
	}
	return id, 1, nil
}

// addVersion adds html as the next version of a page sub can edit.
// restoredFrom records the version it was copied from, if any.
func addVersion(ctx context.Context, tx pgx.Tx, assetID, html string, note *string, sub string, restoredFrom *int) (int, error) {
	if err := checkPage(ctx, tx, assetID, sub, RoleEditor); err != nil {
		return 0, err
	}
	var next int
	err := tx.QueryRow(ctx, `
		UPDATE asset
		SET current_version = current_version + 1, updated_at = now(), updated_by_sub = $2
		WHERE id = $1::uuid AND deleted_at IS NULL AND archived_at IS NULL
		RETURNING current_version`, assetID, sub).Scan(&next)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if err := insertVersion(ctx, tx, assetID, next, html, note, sub, restoredFrom); err != nil {
		return 0, err
	}
	return next, nil
}

// insertVersion stores a page version, which becomes current, and reindexes
// the page for search.
func insertVersion(ctx context.Context, tx pgx.Tx, assetID string, version int, html string, note *string, sub string, restoredFrom *int) error {
	sum := sha256.Sum256([]byte(html))
	if _, err := tx.Exec(ctx, `
		INSERT INTO asset_version (asset_id, version, content, content_hash, size_bytes, edited_by_sub, restored_from_version, note)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8)`,
		assetID, version, html, hex.EncodeToString(sum[:]), len(html), sub, restoredFrom, note); err != nil {
		return err
	}
	return reindex(ctx, tx, assetID, &html)
}

// PageMeta returns the metadata of a page sub can see.
func (s *Store) PageMeta(ctx context.Context, sub, id string) (*PageMeta, error) {
	var m PageMeta
	var r Role
	err := s.pool.QueryRow(ctx, `
		SELECT a.id::text, a.name, a.slug, a.folder_id::text, a.current_version, a.updated_at, r.level,
		       EXISTS (SELECT 1 FROM acl_entry e WHERE e.asset_id = a.id), `+favoritePage("$2")+`
		FROM asset a CROSS JOIN LATERAL (SELECT asset_access($2, a.id) AS level) r
		WHERE a.id = $1::uuid AND r.level > 0
		  AND a.deleted_at IS NULL AND a.archived_at IS NULL`, id, sub).
		Scan(&m.ID, &m.Name, &m.Slug, &m.FolderID, &m.Version, &m.UpdatedAt, &r, &m.Shared, &m.Favorite)
	m.Role = r.String()
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// CurrentContent returns the HTML of the current version of a page sub can
// see.
func (s *Store) CurrentContent(ctx context.Context, sub, id string) (string, error) {
	var html string
	err := s.pool.QueryRow(ctx, `
		SELECT av.content
		FROM asset a
		JOIN asset_version av ON av.asset_id = a.id AND av.version = a.current_version
		WHERE a.id = $1::uuid AND asset_access($2, a.id) > 0
		  AND a.deleted_at IS NULL AND a.archived_at IS NULL`, id, sub).Scan(&html)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return "", ErrNotFound
	}
	return html, err
}

// CurrentVersion returns the number and content hash of the current version of
// a page sub can see, so a cached copy can be validated without loading the
// HTML.
func (s *Store) CurrentVersion(ctx context.Context, sub, id string) (version int, hash string, err error) {
	err = s.pool.QueryRow(ctx, `
		SELECT av.version, av.content_hash
		FROM asset a
		JOIN asset_version av ON av.asset_id = a.id AND av.version = a.current_version
		WHERE a.id = $1::uuid AND asset_access($2, a.id) > 0
		  AND a.deleted_at IS NULL AND a.archived_at IS NULL`, id, sub).Scan(&version, &hash)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return 0, "", ErrNotFound
	}
	return version, hash, err
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

// isInvalidText reports a malformed input such as a non-UUID id, which can't
// name any item and so is treated as not found.
func isInvalidText(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "22P02"
}

// UpsertUser records a user seen at login, keyed by their OIDC subject. Empty
// email or name never overwrite a value already on file.
func (s *Store) UpsertUser(ctx context.Context, sub, email, name string) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO app_user (sub, email, name)
		VALUES ($1, NULLIF($2, ''), NULLIF($3, ''))
		ON CONFLICT (sub) DO UPDATE SET
		  email         = COALESCE(EXCLUDED.email, app_user.email),
		  name          = COALESCE(EXCLUDED.name, app_user.name),
		  last_login_at = now()`, sub, email, name)
	return err
}
