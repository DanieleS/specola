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

// Visibility: until sharing lands, folders and pages are private to the user
// who created them. Every read and write below is scoped to the caller's sub,
// and an item the caller can't see is reported as ErrNotFound so its existence
// isn't leaked.

// querier is the part of pgxpool.Pool and pgx.Tx the helpers below need.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// checkFolder returns ErrNotFound unless folderID is nil (the root) or names an
// active folder owned by sub.
func checkFolder(ctx context.Context, q querier, folderID *string, sub string) error {
	if folderID == nil {
		return nil
	}
	var ok bool
	err := q.QueryRow(ctx, `
		SELECT EXISTS (
		  SELECT 1 FROM folder
		  WHERE id = $1::uuid AND created_by_sub = $2
		    AND deleted_at IS NULL AND archived_at IS NULL)`, *folderID, sub).Scan(&ok)
	if err != nil {
		if isInvalidText(err) {
			return ErrNotFound
		}
		return err
	}
	if !ok {
		return ErrNotFound
	}
	return nil
}

// Tree lists sub's active folders and pages directly under parentID (nil =
// root).
func (s *Store) Tree(ctx context.Context, sub string, parentID *string) ([]TreeItem, error) {
	if err := checkFolder(ctx, s.pool, parentID, sub); err != nil {
		return nil, err
	}
	items := []TreeItem{}

	fr, err := s.pool.Query(ctx, `
		SELECT id::text, name, slug, updated_at
		FROM folder
		WHERE deleted_at IS NULL AND archived_at IS NULL
		  AND parent_id IS NOT DISTINCT FROM $1::uuid
		  AND created_by_sub = $2
		ORDER BY name`, parentID, sub)
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
		  AND created_by_sub = $2
		ORDER BY updated_at DESC`, parentID, sub)
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
// on collision. The parent must be visible to sub.
func (s *Store) CreateFolder(ctx context.Context, parentID *string, name, sub string) (string, error) {
	if err := checkFolder(ctx, s.pool, parentID, sub); err != nil {
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

// CreatePage creates an asset and its version 1 in one transaction. The folder
// must be visible to sub.
func (s *Store) CreatePage(ctx context.Context, folderID *string, name, html, sub string) (id string, version int, err error) {
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		id, version, err = createPage(ctx, tx, folderID, name, html, sub)
		return err
	})
	return id, version, err
}

// AddVersion appends a new version to one of sub's pages and returns its
// number.
func (s *Store) AddVersion(ctx context.Context, assetID, html, sub string) (version int, err error) {
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		version, err = addVersion(ctx, tx, assetID, html, sub)
		return err
	})
	return version, err
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

func createPage(ctx context.Context, tx pgx.Tx, folderID *string, name, html, sub string) (id string, version int, err error) {
	if err = checkFolder(ctx, tx, folderID, sub); err != nil {
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

	if err = insertVersion(ctx, tx, id, 1, html, sub); err != nil {
		return "", 0, err
	}
	return id, 1, nil
}

func addVersion(ctx context.Context, tx pgx.Tx, assetID, html, sub string) (int, error) {
	var next int
	err := tx.QueryRow(ctx, `
		UPDATE asset
		SET current_version = current_version + 1, updated_at = now(), updated_by_sub = $2
		WHERE id = $1::uuid AND created_by_sub = $2
		  AND deleted_at IS NULL AND archived_at IS NULL
		RETURNING current_version`, assetID, sub).Scan(&next)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if err := insertVersion(ctx, tx, assetID, next, html, sub); err != nil {
		return 0, err
	}
	return next, nil
}

func insertVersion(ctx context.Context, tx pgx.Tx, assetID string, version int, html, sub string) error {
	sum := sha256.Sum256([]byte(html))
	_, err := tx.Exec(ctx, `
		INSERT INTO asset_version (asset_id, version, content, content_hash, size_bytes, edited_by_sub)
		VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
		assetID, version, html, hex.EncodeToString(sum[:]), len(html), sub)
	return err
}

// PageMeta returns the metadata of one of sub's pages.
func (s *Store) PageMeta(ctx context.Context, sub, id string) (*PageMeta, error) {
	var m PageMeta
	err := s.pool.QueryRow(ctx, `
		SELECT id::text, name, slug, folder_id::text, current_version, updated_at
		FROM asset
		WHERE id = $1::uuid AND created_by_sub = $2
		  AND deleted_at IS NULL AND archived_at IS NULL`, id, sub).
		Scan(&m.ID, &m.Name, &m.Slug, &m.FolderID, &m.Version, &m.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

// CurrentContent returns the HTML of the current version of one of sub's pages.
func (s *Store) CurrentContent(ctx context.Context, sub, id string) (string, error) {
	var html string
	err := s.pool.QueryRow(ctx, `
		SELECT av.content
		FROM asset a
		JOIN asset_version av ON av.asset_id = a.id AND av.version = a.current_version
		WHERE a.id = $1::uuid AND a.created_by_sub = $2
		  AND a.deleted_at IS NULL AND a.archived_at IS NULL`, id, sub).Scan(&html)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return "", ErrNotFound
	}
	return html, err
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
