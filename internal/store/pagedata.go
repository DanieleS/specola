package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// Page data is a small key-value store a page keeps for each user who views it:
// the localStorage Specola gives it in place of the one its sandbox denies it.
// Each user's data is private to them; anyone who can see the page has their
// own. It follows the page's visibility: archived or unshared, it is kept but
// out of reach.

const (
	// The page runtime (internal/server/pagesdk.js) enforces the same limits,
	// so a page sees QuotaExceededError at once instead of a refused write.

	// MaxPageDataBytes bounds one user's data on one page, keys and values.
	MaxPageDataBytes = 1 << 20
	// MaxPageDataKeys bounds how many keys one user keeps on one page.
	MaxPageDataKeys = 1000
	// MaxPageDataKeyBytes bounds a single key.
	MaxPageDataKeyBytes = 512
)

// PageData returns the data sub keeps on page id.
func (s *Store) PageData(ctx context.Context, sub, id string) (map[string]string, error) {
	if err := checkPage(ctx, s.pool, id, sub, RoleViewer); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `SELECT key, value FROM page_data WHERE asset_id = $1::uuid AND user_sub = $2`, id, sub)
	if err != nil {
		return nil, err
	}
	data := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		data[k] = v
	}
	return data, rows.Err()
}

// PageDataChange is one update to a user's page data: clear everything first
// if Clear, then drop Remove and write Set.
type PageDataChange struct {
	Set    map[string]string
	Remove []string
	Clear  bool
}

// UpdatePageData applies a change to the data sub keeps on page id, all or
// nothing. Viewing the page is enough: the data is sub's own.
func (s *Store) UpdatePageData(ctx context.Context, sub, id string, c PageDataChange) error {
	for k := range c.Set {
		if len(k) > MaxPageDataKeyBytes {
			return &ErrInvalid{fmt.Sprintf("keys must be at most %d bytes", MaxPageDataKeyBytes)}
		}
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkPage(ctx, tx, id, sub, RoleViewer); err != nil {
			return err
		}
		// Serialise writers on the same data, so the quota check below sees
		// every change that commits before this one.
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1 || '/' || $2, 0))`, id, sub); err != nil {
			return err
		}
		if c.Clear {
			if _, err := tx.Exec(ctx, `DELETE FROM page_data WHERE asset_id = $1::uuid AND user_sub = $2`, id, sub); err != nil {
				return err
			}
		}
		if len(c.Remove) > 0 {
			if _, err := tx.Exec(ctx, `DELETE FROM page_data WHERE asset_id = $1::uuid AND user_sub = $2 AND key = ANY($3)`,
				id, sub, c.Remove); err != nil {
				return err
			}
		}
		if len(c.Set) > 0 {
			keys := make([]string, 0, len(c.Set))
			values := make([]string, 0, len(c.Set))
			for k, v := range c.Set {
				keys = append(keys, k)
				values = append(values, v)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO page_data (asset_id, user_sub, key, value)
				SELECT $1::uuid, $2, k, v FROM unnest($3::text[], $4::text[]) AS t(k, v)
				ON CONFLICT (asset_id, user_sub, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
				id, sub, keys, values); err != nil {
				return err
			}
		}
		var n, size int64
		if err := tx.QueryRow(ctx, `
			SELECT count(*), COALESCE(sum(octet_length(key) + octet_length(value)), 0)
			FROM page_data WHERE asset_id = $1::uuid AND user_sub = $2`, id, sub).Scan(&n, &size); err != nil {
			return err
		}
		if n > MaxPageDataKeys || size > MaxPageDataBytes {
			return &ErrInvalid{fmt.Sprintf("page data is limited to %d keys and %d KB per user", MaxPageDataKeys, MaxPageDataBytes>>10)}
		}
		return nil
	})
}
