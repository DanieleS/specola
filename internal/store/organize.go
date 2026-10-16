package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Version history, rename, move and archive.

// ErrInvalid is a request that can't be carried out as asked, such as moving a
// folder into itself; its message says why.
type ErrInvalid struct{ Reason string }

func (e *ErrInvalid) Error() string { return e.Reason }

// VersionInfo describes one version in a page's history.
type VersionInfo struct {
	Version      int       `json:"version"`
	SizeBytes    int       `json:"sizeBytes"`
	CreatedAt    time.Time `json:"createdAt"`
	EditedBy     string    `json:"editedBy,omitempty"` // email, or sub when unknown
	RestoredFrom *int      `json:"restoredFrom,omitempty"`
}

// Versions lists a page's versions, newest first. sub must be able to see it.
func (s *Store) Versions(ctx context.Context, sub, id string) ([]VersionInfo, error) {
	if err := checkPage(ctx, s.pool, id, sub, RoleViewer); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT v.version, v.size_bytes, v.created_at, COALESCE(u.email, v.edited_by_sub, ''), v.restored_from_version
		FROM asset_version v LEFT JOIN app_user u ON u.sub = v.edited_by_sub
		WHERE v.asset_id = $1::uuid
		ORDER BY v.version DESC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []VersionInfo{}
	for rows.Next() {
		var v VersionInfo
		if err := rows.Scan(&v.Version, &v.SizeBytes, &v.CreatedAt, &v.EditedBy, &v.RestoredFrom); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// VersionContent returns the HTML of one version of a page sub can see.
func (s *Store) VersionContent(ctx context.Context, sub, id string, version int) (string, error) {
	if err := checkPage(ctx, s.pool, id, sub, RoleViewer); err != nil {
		return "", err
	}
	return versionContent(ctx, s.pool, id, version)
}

func versionContent(ctx context.Context, q querier, id string, version int) (string, error) {
	var html string
	err := q.QueryRow(ctx, `SELECT content FROM asset_version WHERE asset_id = $1::uuid AND version = $2`, id, version).Scan(&html)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return html, err
}

// RestoreVersion copies an earlier version's HTML into a new current version,
// keeping the history intact, and returns the new version number.
func (s *Store) RestoreVersion(ctx context.Context, sub, id string, from int) (version int, err error) {
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkPage(ctx, tx, id, sub, RoleEditor); err != nil {
			return err
		}
		html, err := versionContent(ctx, tx, id, from)
		if err != nil {
			return err
		}
		version, err = addVersion(ctx, tx, id, html, sub, &from)
		return err
	})
	return version, err
}

// Rename renames an item sub can edit. Its slug follows the new name.
func (s *Store) Rename(ctx context.Context, sub string, kind ItemKind, id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return &ErrInvalid{"name is required"}
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkItem(ctx, tx, kind, id, sub, RoleEditor, false); err != nil {
			return err
		}
		parent, err := parentOf(ctx, tx, kind, id)
		if err != nil {
			return err
		}
		return relocate(ctx, tx, kind, id, name, parent, false, sub)
	})
}

// Move moves an item sub can edit into dest, a folder sub can edit, or to the
// root (nil), which only the item's owner may do since it lands in the
// creator's own root. A folder can't move into itself or below itself.
func (s *Store) Move(ctx context.Context, sub string, kind ItemKind, id string, dest *string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		min := RoleEditor
		if dest == nil {
			min = RoleOwner
		}
		if err := checkItem(ctx, tx, kind, id, sub, min, false); err != nil {
			return err
		}
		if err := checkFolder(ctx, tx, dest, sub, RoleEditor); err != nil {
			return err
		}
		if kind == KindFolder && dest != nil {
			var cycle bool
			if err := tx.QueryRow(ctx, `
				WITH RECURSIVE up AS (
				  SELECT id, parent_id, 0 AS depth FROM folder WHERE id = $1::uuid
				  UNION ALL
				  SELECT f.id, f.parent_id, up.depth + 1 FROM folder f JOIN up ON f.id = up.parent_id
				  WHERE up.depth < 64
				)
				SELECT EXISTS (SELECT 1 FROM up WHERE id = $2::uuid)`, *dest, id).Scan(&cycle); err != nil {
				return err
			}
			if cycle {
				return &ErrInvalid{"a folder can't be moved into itself or one of its sub-folders"}
			}
		}
		name, err := nameOf(ctx, tx, kind, id)
		if err != nil {
			return err
		}
		return relocate(ctx, tx, kind, id, name, dest, false, sub)
	})
}

// Archive hides an item and everything beneath it. Only its owner may.
func (s *Store) Archive(ctx context.Context, sub string, kind ItemKind, id string) error {
	if err := checkItem(ctx, s.pool, kind, id, sub, RoleOwner, false); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE `+kind.table()+` SET archived_at = now(), archived_by_sub = $2
		WHERE id = $1::uuid AND archived_at IS NULL`, id, sub)
	return err
}

// Unarchive restores an archived item, taking a new slug if its old one has
// been reused meanwhile. Only its owner may.
func (s *Store) Unarchive(ctx context.Context, sub string, kind ItemKind, id string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkItem(ctx, tx, kind, id, sub, RoleOwner, true); err != nil {
			return err
		}
		var archived bool
		if err := tx.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM `+kind.table()+` WHERE id = $1::uuid`, id).Scan(&archived); err != nil {
			return err
		}
		if !archived {
			return nil
		}
		name, err := nameOf(ctx, tx, kind, id)
		if err != nil {
			return err
		}
		parent, err := parentOf(ctx, tx, kind, id)
		if err != nil {
			return err
		}
		return relocate(ctx, tx, kind, id, name, parent, true, sub)
	})
}

// Archived lists the archived items sub owns, most recently archived first.
// Items inside an archived folder are restored with it and aren't listed.
func (s *Store) Archived(ctx context.Context, sub string) ([]TreeItem, error) {
	return listItems(ctx, s.pool, `
		SELECT 'folder', f.id::text, f.name, f.slug, 0, f.archived_at, 3,
		       EXISTS (SELECT 1 FROM acl_entry e WHERE e.folder_id = f.id)
		FROM folder f
		WHERE f.archived_at IS NOT NULL AND f.deleted_at IS NULL
		  AND folder_access($1, f.id, true) = 3
		  AND (f.parent_id IS NULL OR NOT folder_hidden(f.parent_id))
		ORDER BY f.archived_at DESC`, `
		SELECT 'page', a.id::text, a.name, a.slug, a.current_version, a.archived_at, 3,
		       EXISTS (SELECT 1 FROM acl_entry e WHERE e.asset_id = a.id)
		FROM asset a
		WHERE a.archived_at IS NOT NULL AND a.deleted_at IS NULL
		  AND asset_access($1, a.id, true) = 3
		  AND (a.folder_id IS NULL OR NOT folder_hidden(a.folder_id))
		ORDER BY a.archived_at DESC`, sub)
}

// relocate sets an item's name and parent, choosing a slug from the name that
// is free in the destination, and optionally unarchives it. Each slug attempt
// runs in a savepoint, since a unique violation would abort the transaction.
func relocate(ctx context.Context, tx pgx.Tx, kind ItemKind, id, name string, parent *string, unarchive bool, sub string) error {
	set := ""
	if unarchive {
		set = ", archived_at = NULL, archived_by_sub = NULL"
	}
	base := slugify(name)
	for i := 0; i < 25; i++ {
		sp, err := tx.Begin(ctx)
		if err != nil {
			return err
		}
		_, err = sp.Exec(ctx, `
			UPDATE `+kind.table()+`
			SET name = $2, `+kind.parentColumn()+` = $3::uuid, slug = $4,
			    updated_at = now(), updated_by_sub = $5`+set+`
			WHERE id = $1::uuid`, id, name, parent, withSuffix(base, i), sub)
		if err == nil {
			if err := sp.Commit(ctx); err != nil {
				return err
			}
			if kind == KindPage {
				return reindex(ctx, tx, id, nil)
			}
			return nil
		}
		_ = sp.Rollback(ctx)
		if !isUniqueViolation(err) {
			return err
		}
	}
	return errors.New("could not allocate a unique slug")
}

// checkItem checks sub's role on an item of either kind. includeArchived
// resolves it even when the item or a folder above it is archived.
func checkItem(ctx context.Context, q querier, kind ItemKind, id, sub string, min Role, includeArchived bool) error {
	fn := "asset_access"
	if kind == KindFolder {
		fn = "folder_access"
	}
	var r Role
	err := q.QueryRow(ctx, `
		SELECT COALESCE(MAX(`+fn+`($2, id, $3)), 0) FROM `+kind.table()+`
		WHERE id = $1::uuid AND deleted_at IS NULL`, id, sub, includeArchived).Scan(&r)
	if isInvalidText(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	return need(r, min)
}

func nameOf(ctx context.Context, q querier, kind ItemKind, id string) (string, error) {
	var name string
	err := q.QueryRow(ctx, `SELECT name FROM `+kind.table()+` WHERE id = $1::uuid`, id).Scan(&name)
	return name, err
}

func parentOf(ctx context.Context, q querier, kind ItemKind, id string) (*string, error) {
	var parent *string
	err := q.QueryRow(ctx, `SELECT `+kind.parentColumn()+`::text FROM `+kind.table()+` WHERE id = $1::uuid`, id).Scan(&parent)
	return parent, err
}
