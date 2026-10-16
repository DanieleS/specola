// Package store holds Specola's data access on top of a pgx connection pool.
// IDs are handled as strings (selected as `id::text`) to keep the layer free of
// UUID codec concerns.
package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

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
}

// PageMeta is the metadata the viewer header needs.
type PageMeta struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Slug      string    `json:"slug"`
	FolderID  *string   `json:"folderId"`
	Version   int       `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Tree lists active folders and pages directly under parentID (nil = root).
func (s *Store) Tree(ctx context.Context, parentID *string) ([]TreeItem, error) {
	items := []TreeItem{}

	fr, err := s.pool.Query(ctx, `
		SELECT id::text, name, slug, updated_at
		FROM folder
		WHERE deleted_at IS NULL AND archived_at IS NULL
		  AND parent_id IS NOT DISTINCT FROM $1::uuid
		ORDER BY name`, parentID)
	if err != nil {
		return nil, err
	}
	for fr.Next() {
		it := TreeItem{Kind: "folder"}
		if err := fr.Scan(&it.ID, &it.Name, &it.Slug, &it.UpdatedAt); err != nil {
			fr.Close()
			return nil, err
		}
		items = append(items, it)
	}
	fr.Close()
	if err := fr.Err(); err != nil {
		return nil, err
	}

	ar, err := s.pool.Query(ctx, `
		SELECT id::text, name, slug, current_version, updated_at
		FROM asset
		WHERE deleted_at IS NULL AND archived_at IS NULL
		  AND folder_id IS NOT DISTINCT FROM $1::uuid
		ORDER BY updated_at DESC`, parentID)
	if err != nil {
		return nil, err
	}
	defer ar.Close()
	for ar.Next() {
		it := TreeItem{Kind: "page"}
		if err := ar.Scan(&it.ID, &it.Name, &it.Slug, &it.Version, &it.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, ar.Err()
}

// CreateFolder inserts a folder under parentID (nil = root), retrying the slug
// on collision.
func (s *Store) CreateFolder(ctx context.Context, parentID *string, name, sub string) (string, error) {
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

// CreatePage creates an asset and its version 1 in one transaction.
func (s *Store) CreatePage(ctx context.Context, folderID *string, name, html, sub string) (id string, version int, err error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", 0, err
	}
	defer tx.Rollback(ctx)

	base := slugify(name)
	created := false
	for i := 0; i < 25; i++ {
		err = tx.QueryRow(ctx, `
			INSERT INTO asset (folder_id, name, slug, created_by_sub, updated_by_sub, current_version)
			VALUES ($1::uuid, $2, $3, $4, $4, 1)
			RETURNING id::text`, folderID, name, withSuffix(base, i), sub).Scan(&id)
		if err == nil {
			created = true
			break
		}
		if !isUniqueViolation(err) {
			return "", 0, err
		}
	}
	if !created {
		return "", 0, errors.New("could not allocate a unique page slug")
	}

	sum := sha256.Sum256([]byte(html))
	if _, err = tx.Exec(ctx, `
		INSERT INTO asset_version (asset_id, version, content, content_hash, size_bytes, edited_by_sub)
		VALUES ($1::uuid, 1, $2, $3, $4, $5)`,
		id, html, hex.EncodeToString(sum[:]), len(html), sub); err != nil {
		return "", 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", 0, err
	}
	return id, 1, nil
}

// AddVersion appends a new version to an existing page and returns its number.
func (s *Store) AddVersion(ctx context.Context, assetID, html, sub string) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	var next int
	err = tx.QueryRow(ctx, `
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

	sum := sha256.Sum256([]byte(html))
	if _, err = tx.Exec(ctx, `
		INSERT INTO asset_version (asset_id, version, content, content_hash, size_bytes, edited_by_sub)
		VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
		assetID, next, html, hex.EncodeToString(sum[:]), len(html), sub); err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	return next, nil
}

// PageMeta returns a page's metadata.
func (s *Store) PageMeta(ctx context.Context, id string) (*PageMeta, error) {
	var m PageMeta
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, name, slug, folder_id::text, current_version, updated_at
		FROM asset
		WHERE id = $1::uuid AND deleted_at IS NULL AND archived_at IS NULL`, id).
		Scan(&m.ID, &m.Name, &m.Slug, &m.FolderID, &m.Version, &m.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// CurrentContent returns the HTML of a page's current version.
func (s *Store) CurrentContent(ctx context.Context, id string) (string, error) {
	var html string
	err := s.pool.QueryRow(ctx, `
		SELECT av.content
		FROM asset a
		JOIN asset_version av ON av.asset_id = a.id AND av.version = a.current_version
		WHERE a.id = $1::uuid AND a.deleted_at IS NULL AND a.archived_at IS NULL`, id).Scan(&html)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return html, err
}

func isUniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
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
