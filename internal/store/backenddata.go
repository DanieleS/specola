package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Backend data (docs/page-backends.md, "Data lifecycle"). The data itself is
// on the runner's volume; Postgres only records whether a page has some
// (asset.backend_used_at) and, through backend_dormant_since, since when it
// has been out of reach, which is what the purge goes by.

// BackendUsedEvery is how stale asset.backend_used_at may get before a call
// writes it again: often enough to say the page is in use, rarely enough
// that calls don't each write a row. MarkBackendUsed's SQL says the same.
const BackendUsedEvery = time.Hour

// MarkBackendUsed records that the runner holds data for page id, which it
// just answered a call for. The row is written only when the mark is missing
// or older than BackendUsedEvery, so this is cheap to call on every call.
// id is the page's canonical id; access was checked by the caller.
func (s *Store) MarkBackendUsed(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE asset SET backend_used_at = now()
		WHERE id = $1::uuid AND (backend_used_at IS NULL OR backend_used_at < now() - interval '1 hour')`, id)
	if isInvalidText(err) {
		return ErrNotFound
	}
	return err
}

// BackendDormancy returns, for those of the pages ids that have backend data
// and are dormant, since when. Pages that have no data, or whose data is
// live, are left out. It doesn't check access.
func (s *Store) BackendDormancy(ctx context.Context, ids []string) (map[string]time.Time, error) {
	out := map[string]time.Time{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT a.id::text, d.since
		FROM asset a CROSS JOIN LATERAL (SELECT backend_dormant_since(a.id) AS since) d
		WHERE a.id = ANY($1::uuid[]) AND a.backend_used_at IS NOT NULL AND d.since IS NOT NULL`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id    string
			since time.Time
		)
		if err := rows.Scan(&id, &since); err != nil {
			return nil, err
		}
		out[id] = since
	}
	return out, rows.Err()
}

// BackendFolderDormancy returns, for those of the folders ids that hold
// (at any depth) pages with backend data that is dormant, the earliest such
// page's dormant-since time. The Archived list shows an archived folder,
// not the pages inside it, so this is where those pages' purge date goes:
// the first purge among them is the one to warn about. It doesn't check
// access (the folders' own listing did).
func (s *Store) BackendFolderDormancy(ctx context.Context, ids []string) (map[string]time.Time, error) {
	out := map[string]time.Time{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		WITH RECURSIVE tree AS (
			SELECT f.id AS root, f.id, 0 AS depth FROM folder f WHERE f.id = ANY($1::uuid[])
			UNION ALL
			SELECT t.root, c.id, t.depth + 1
			FROM folder c JOIN tree t ON c.parent_id = t.id
			WHERE t.depth < 64
		)
		SELECT t.root::text, min(d.since)
		FROM tree t
		JOIN asset a ON a.folder_id = t.id
		CROSS JOIN LATERAL (SELECT backend_dormant_since(a.id) AS since) d
		WHERE a.backend_used_at IS NOT NULL AND a.deleted_at IS NULL AND d.since IS NOT NULL
		GROUP BY t.root`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id    string
			since time.Time
		)
		if err := rows.Scan(&id, &since); err != nil {
			return nil, err
		}
		out[id] = since
	}
	return out, rows.Err()
}

// BackendPurgeDue lists the pages with backend data that has been dormant
// since before the given time, oldest first.
func (s *Store) BackendPurgeDue(ctx context.Context, before time.Time) ([]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.id::text
		FROM asset a CROSS JOIN LATERAL (SELECT backend_dormant_since(a.id) AS since) d
		WHERE a.backend_used_at IS NOT NULL AND d.since < $1
		ORDER BY d.since`, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// PurgeBackendData purges page id's backend data with purge (the runner's
// DELETE), if it is still due (dormant since before the given time), and
// then clears its mark. It reports whether purge ran.
//
// The page's row is locked meanwhile: unarchiving the page or giving it a
// new version writes that row, so it waits for the purge to finish rather
// than have its first calls' data deleted. (Unarchiving a folder above it
// doesn't wait; the runner takes the page offline while it purges, so such
// a call finds the page empty, as the purge was due anyway.) A failed purge
// leaves the mark, so the next round tries again.
func (s *Store) PurgeBackendData(ctx context.Context, id string, before time.Time, purge func(context.Context) error) (bool, error) {
	ran := false
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		// Lock first, then look: a statement sees what was committed when
		// it started, so the check must come after any wait for the lock.
		var marked bool
		err := tx.QueryRow(ctx, `SELECT backend_used_at IS NOT NULL FROM asset WHERE id = $1::uuid FOR UPDATE`, id).Scan(&marked)
		if isInvalidText(err) {
			// The transaction is aborted: it can't just commit.
			return ErrNotFound
		}
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !marked) {
			return nil
		}
		if err != nil {
			return err
		}
		var due bool
		if err := tx.QueryRow(ctx, `SELECT COALESCE(backend_dormant_since($1::uuid) < $2, false)`, id, before).Scan(&due); err != nil || !due {
			return err
		}
		if err := purge(ctx); err != nil {
			return err
		}
		ran = true
		_, err = tx.Exec(ctx, `UPDATE asset SET backend_used_at = NULL WHERE id = $1::uuid`, id)
		return err
	})
	if errors.Is(err, ErrNotFound) {
		return false, nil
	}
	return ran, err
}
