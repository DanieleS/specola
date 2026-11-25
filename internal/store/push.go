package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/danieles/specola/internal/backend"

	"github.com/jackc/pgx/v5"
)

// Realtime push and public-link calls to page backends
// (docs/page-backends.md, "Realtime push" and "Public links"). A push goes
// through Postgres (NOTIFY), so that every replica delivers it to the
// streams it holds; these are the few queries the server needs for that,
// and to call a backend through a public link.

// ListenConn takes a connection out of the pool for good, for LISTEN: it
// must stay the same connection for as long as it listens, and must not be
// handed to anyone else meanwhile. The caller closes it.
func (s *Store) ListenConn(ctx context.Context) (*pgx.Conn, error) {
	c, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, err
	}
	return c.Hijack(), nil
}

// Notify sends payload on a NOTIFY channel. Postgres refuses payloads of
// 8000 bytes or more.
func (s *Store) Notify(ctx context.Context, channel, payload string) error {
	_, err := s.pool.Exec(ctx, `SELECT pg_notify($1, $2)`, channel, payload)
	return err
}

// PageID returns page id's canonical spelling, ErrNotFound when there is no
// such page (deleted ones included). No user is involved: it is for the
// runner, which only names pages it was sent.
func (s *Store) PageID(ctx context.Context, id string) (string, error) {
	var canonical string
	err := s.pool.QueryRow(ctx, `SELECT id::text FROM asset WHERE id = $1::uuid AND deleted_at IS NULL`, id).Scan(&canonical)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return "", ErrNotFound
	}
	return canonical, err
}

// CurrentVersions returns the current version of each of the pages ids
// (canonical spellings) that exists, keyed by id. No access is checked.
func (s *Store) CurrentVersions(ctx context.Context, ids []string) (map[string]int, error) {
	out := make(map[string]int, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id::text, current_version FROM asset
		WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, ids)
	if isInvalidText(err) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id string
			v  int
		)
		if err := rows.Scan(&id, &v); err != nil {
			return nil, err
		}
		out[id] = v
	}
	return out, rows.Err()
}

// PublicTarget is what a call through a public link needs to know: the link,
// and the version it shows with its backend.
type PublicTarget struct {
	LinkID, Label string
	// ID is the page's canonical id; Version the version the link shows
	// (the current one, unless the link is pinned).
	ID        string
	Title     string
	Version   int
	VersionID string
	// CodeHash is "" and Manifest nil when that version has no backend.
	CodeHash string
	Manifest *backend.Manifest
}

// PublicBackendTarget resolves a public link's token for a backend call or
// the public shell, with the same rules as OpenPublicLink (ErrNotFound,
// ErrLinkExpired, ErrSuperseded) but without counting a view.
func (s *Store) PublicBackendTarget(ctx context.Context, token string) (*PublicTarget, error) {
	var (
		t               PublicTarget
		hash            *string
		manifest        []byte
		expired, owner  bool
		viewableVersion bool
	)
	err := s.pool.QueryRow(ctx, `
		SELECT l.id::text, COALESCE(l.label, ''), a.id::text, a.name, v.version, v.id::text,
		       v.backend_hash, v.backend,
		       l.expires_at IS NOT NULL AND l.expires_at <= now(),
		       asset_access(l.created_by_sub, a.id) = 3,
		       `+viewable+`
		FROM public_link l
		JOIN asset a ON a.id = l.asset_id
		JOIN asset_version v ON v.asset_id = a.id AND v.version = COALESCE(l.version, a.current_version)
		JOIN asset_version cur ON cur.asset_id = a.id AND cur.version = a.current_version
		WHERE l.secret_hash = $1`, hashToken(token)).
		Scan(&t.LinkID, &t.Label, &t.ID, &t.Title, &t.Version, &t.VersionID, &hash, &manifest, &expired, &owner, &viewableVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	switch {
	case !owner:
		return nil, ErrNotFound
	case expired:
		return nil, ErrLinkExpired
	case !viewableVersion:
		return nil, ErrSuperseded
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

// PublicLinkPage is what a public link shows, for its shell and manifest
// (docs/page-apps.md, "Public apps") and for a copy kept for offline: the
// target and its version, served as OpenPublicLink serves it, with the same
// errors, but without counting a view.
func (s *Store) PublicLinkPage(ctx context.Context, token string) (*PublicTarget, *ServedVersion, error) {
	t, err := s.PublicBackendTarget(ctx, token)
	if err != nil {
		return nil, nil, err
	}
	sv, err := servedVersion(ctx, s.pool, t.ID, t.Version)
	if err != nil {
		return nil, nil, err
	}
	return t, sv, nil
}
