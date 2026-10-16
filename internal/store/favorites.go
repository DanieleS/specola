package store

import "context"

// Favorites are personal stars on folders and pages. Starring needs only to be
// able to see the item. A star outlives losing sight of the item (an unshare,
// an archive) but is not listed meanwhile, so it comes back with the access.

// SetFavorite stars (on) or unstars an item sub can see. Both are idempotent.
func (s *Store) SetFavorite(ctx context.Context, sub string, kind ItemKind, id string, on bool) error {
	if err := checkItem(ctx, s.pool, kind, id, sub, RoleViewer, false); err != nil {
		return err
	}
	col := kind.column()
	var err error
	if on {
		// The unique indexes on favorite are partial, one per column, so the
		// conflict target has to name the one that applies.
		_, err = s.pool.Exec(ctx, `
			INSERT INTO favorite (user_sub, `+col+`) VALUES ($1, $2::uuid)
			ON CONFLICT (user_sub, `+col+`) WHERE `+col+` IS NOT NULL DO NOTHING`, sub, id)
	} else {
		_, err = s.pool.Exec(ctx, `DELETE FROM favorite WHERE user_sub = $1 AND `+col+` = $2::uuid`, sub, id)
	}
	return err
}

// Favorites lists the items sub starred and can still see, folders by name
// then pages most recently updated first.
func (s *Store) Favorites(ctx context.Context, sub string) ([]TreeItem, error) {
	return listItems(ctx, s.pool, `
		SELECT 'folder', f.id::text, f.name, f.slug, 0, f.updated_at, folder_access($1, f.id),
		       EXISTS (SELECT 1 FROM acl_entry e WHERE e.folder_id = f.id), true
		FROM favorite fv JOIN folder f ON f.id = fv.folder_id
		WHERE fv.user_sub = $1 AND folder_access($1, f.id) > 0
		ORDER BY f.name`, `
		SELECT 'page', a.id::text, a.name, a.slug, a.current_version, a.updated_at, asset_access($1, a.id),
		       EXISTS (SELECT 1 FROM acl_entry e WHERE e.asset_id = a.id), true
		FROM favorite fv JOIN asset a ON a.id = fv.asset_id
		WHERE fv.user_sub = $1 AND asset_access($1, a.id) > 0
		ORDER BY a.updated_at DESC`, sub)
}
