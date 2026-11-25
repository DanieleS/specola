package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/danieles/specola/internal/pageapp"

	"github.com/jackc/pgx/v5"
)

// Page apps' settings (docs/page-apps.md, "Author settings"; migration
// 0017): what a page's editors set about how it looks installed as an app.
// internal/pageapp works out the rest.

// AppSettings returns page id's app settings, the zero value when none are
// set. It doesn't check access: the caller has (or holds a public link).
func (s *Store) AppSettings(ctx context.Context, id string) (pageapp.Settings, error) {
	return appSettings(ctx, s.pool, id)
}

func appSettings(ctx context.Context, q querier, id string) (pageapp.Settings, error) {
	var (
		st   pageapp.Settings
		size *int
	)
	err := q.QueryRow(ctx, `
		SELECT COALESCE(name, ''), COALESCE(short_name, ''), COALESCE(display, ''), COALESCE(orientation, ''),
		       COALESCE(theme_color, ''), COALESCE(background_color, ''), COALESCE(icon_sha256, ''), icon_size, icon_maskable
		FROM page_app WHERE asset_id = $1::uuid`, id).
		Scan(&st.Name, &st.ShortName, &st.Display, &st.Orientation, &st.ThemeColor, &st.BackgroundColor, &st.Icon, &size, &st.IconMaskable)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return pageapp.Settings{}, nil
	}
	if size != nil {
		st.IconSize = *size
	}
	return st, err
}

// AppSettingsChange changes some of a page's app settings: each field that
// isn't nil is set, "" resetting it to its default.
type AppSettingsChange struct {
	Name, ShortName, Display, Orientation, ThemeColor, BackgroundColor *string
	IconMaskable                                                       *bool
}

// SetAppSettings applies a change to the app settings of a page sub can
// edit, and returns them. An invalid result is ErrInvalid, and nothing
// changes.
func (s *Store) SetAppSettings(ctx context.Context, sub, id string, c AppSettingsChange) (pageapp.Settings, error) {
	var out pageapp.Settings
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkPage(ctx, tx, id, sub, RoleEditor); err != nil {
			return err
		}
		st, err := appSettingsForUpdate(ctx, tx, id)
		if err != nil {
			return err
		}
		for _, f := range []struct {
			to   *string
			from *string
		}{
			{&st.Name, c.Name}, {&st.ShortName, c.ShortName}, {&st.Display, c.Display},
			{&st.Orientation, c.Orientation}, {&st.ThemeColor, c.ThemeColor}, {&st.BackgroundColor, c.BackgroundColor},
		} {
			if f.from != nil {
				*f.to = *f.from
			}
		}
		if c.IconMaskable != nil {
			st.IconMaskable = *c.IconMaskable
		}
		if err := st.Validate(); err != nil {
			return &ErrInvalid{err.Error()}
		}
		out = st
		return putAppSettings(ctx, tx, sub, id, st)
	})
	return out, err
}

// SetAppIcon makes png (checked by pageapp.CheckIcon) the icon of a page sub
// can edit, kept as a bundle blob.
func (s *Store) SetAppIcon(ctx context.Context, sub, id string, png []byte, maskable *bool) (pageapp.Settings, error) {
	size, err := pageapp.CheckIcon(png)
	if err != nil {
		return pageapp.Settings{}, &ErrInvalid{err.Error()}
	}
	sum := sha256.Sum256(png)
	sha := hex.EncodeToString(sum[:])
	var out pageapp.Settings
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkPage(ctx, tx, id, sub, RoleEditor); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO bundle_blob (sha256, size_bytes, content) VALUES ($1, $2, $3)
			ON CONFLICT (sha256) DO UPDATE SET created_at = now()`, sha, len(png), png); err != nil {
			return err
		}
		st, err := appSettingsForUpdate(ctx, tx, id)
		if err != nil {
			return err
		}
		st.Icon, st.IconSize = sha, size
		if maskable != nil {
			st.IconMaskable = *maskable
		}
		out = st
		return putAppSettings(ctx, tx, sub, id, st)
	})
	return out, err
}

// DeleteAppIcon goes back to the generated icon for a page sub can edit.
func (s *Store) DeleteAppIcon(ctx context.Context, sub, id string) (pageapp.Settings, error) {
	var out pageapp.Settings
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkPage(ctx, tx, id, sub, RoleEditor); err != nil {
			return err
		}
		st, err := appSettingsForUpdate(ctx, tx, id)
		if err != nil {
			return err
		}
		st.Icon, st.IconSize, st.IconMaskable = "", 0, false
		out = st
		return putAppSettings(ctx, tx, sub, id, st)
	})
	return out, err
}

// ResetApp drops every app setting of a page sub can edit.
func (s *Store) ResetApp(ctx context.Context, sub, id string) error {
	return s.inTx(ctx, func(tx pgx.Tx) error {
		if err := checkPage(ctx, tx, id, sub, RoleEditor); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM page_app WHERE asset_id = $1::uuid`, id)
		return err
	})
}

// AppIcon returns an uploaded icon by its sha256, if some page's app uses
// it; else ErrNotFound (a bundle's files aren't served here).
func (s *Store) AppIcon(ctx context.Context, sha string) ([]byte, error) {
	var b []byte
	err := s.pool.QueryRow(ctx, `
		SELECT b.content FROM bundle_blob b
		WHERE b.sha256 = $1 AND EXISTS (SELECT 1 FROM page_app a WHERE a.icon_sha256 = b.sha256)`, sha).Scan(&b)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	return b, err
}

func appSettingsForUpdate(ctx context.Context, tx pgx.Tx, id string) (pageapp.Settings, error) {
	if _, err := tx.Exec(ctx, `SELECT 1 FROM page_app WHERE asset_id = $1::uuid FOR UPDATE`, id); err != nil {
		return pageapp.Settings{}, err
	}
	return appSettings(ctx, tx, id)
}

func putAppSettings(ctx context.Context, tx pgx.Tx, sub, id string, st pageapp.Settings) error {
	null := func(s string) *string {
		if s == "" {
			return nil
		}
		return &s
	}
	var size *int
	if st.Icon != "" {
		size = &st.IconSize
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO page_app (asset_id, name, short_name, display, orientation, theme_color, background_color,
		                      icon_sha256, icon_size, icon_maskable, updated_by_sub)
		VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (asset_id) DO UPDATE SET
		  name = EXCLUDED.name, short_name = EXCLUDED.short_name, display = EXCLUDED.display,
		  orientation = EXCLUDED.orientation, theme_color = EXCLUDED.theme_color,
		  background_color = EXCLUDED.background_color, icon_sha256 = EXCLUDED.icon_sha256,
		  icon_size = EXCLUDED.icon_size, icon_maskable = EXCLUDED.icon_maskable,
		  updated_at = now(), updated_by_sub = EXCLUDED.updated_by_sub`,
		id, null(st.Name), null(st.ShortName), null(st.Display), null(st.Orientation), null(st.ThemeColor),
		null(st.BackgroundColor), null(st.Icon), size, st.IconMaskable, sub)
	return err
}
