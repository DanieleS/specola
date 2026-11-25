package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Anonymous visitors of public links (docs/page-apps.md, "Anonymous
// visitors"; migration 0016). The server holds the visitor's secret in a
// cookie and passes its sha256 here; the store keeps the visitor's
// localStorage with the same code and limits as a signed-in user's
// (pagedata.go), under the subject "anon:"+hash.

// ErrNoVisitor: the link is fine, but it knows no visitor by that hash.
var ErrNoVisitor = errors.New("no such visitor on this link")

// ErrVisitorLimit: the link has as many visitors as it may keep.
var ErrVisitorLimit = errors.New("this link keeps no more visitors")

// Visitor is a public link's visitor, by the hash of its secret.
type Visitor struct {
	LinkID, AssetID, Hash string
}

// Sub is the visitor's subject, which its data is kept under, here and on
// the runner. No OIDC sub starts with "anon:" (migration 0016 checks it).
func (v *Visitor) Sub() string { return "anon:" + v.Hash }

func (v *Visitor) owner() dataOwner {
	return dataOwner{asset: v.AssetID, sub: v.Sub(), link: &v.LinkID, visitor: &v.Hash}
}

// seenEvery is how often a visitor's last_seen_at is moved forward: often
// enough for a 90-day sweep, not on every request.
const seenEvery = time.Hour

// Visitor resolves the visitor hash of the public link token, which must be
// usable (else ErrNotFound, ErrLinkExpired or ErrSuperseded, as serving it),
// and records that it was seen. ErrNoVisitor when the link has no such
// visitor (a cookie from before the link was revoked and made again, say).
func (s *Store) Visitor(ctx context.Context, token, hash string) (*Visitor, error) {
	t, err := s.PublicBackendTarget(ctx, token)
	if err != nil {
		return nil, err
	}
	v := &Visitor{LinkID: t.LinkID, AssetID: t.ID, Hash: hash}
	tag, err := s.pool.Exec(ctx, `
		UPDATE public_visitor SET last_seen_at = now()
		WHERE link_id = $1::uuid AND visitor_hash = $2 AND last_seen_at < now() - $3 * interval '1 second'`,
		v.LinkID, hash, int(seenEvery.Seconds()))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		var ok bool
		if err := s.pool.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM public_visitor WHERE link_id = $1::uuid AND visitor_hash = $2)`,
			v.LinkID, hash).Scan(&ok); err != nil {
			return nil, err
		}
		if !ok {
			return nil, ErrNoVisitor
		}
	}
	return v, nil
}

// NewVisitor makes a visitor with hash on the public link token, unless the
// link already keeps max visitors (ErrVisitorLimit).
func (s *Store) NewVisitor(ctx context.Context, token, hash string, max int) (*Visitor, error) {
	t, err := s.PublicBackendTarget(ctx, token)
	if err != nil {
		return nil, err
	}
	v := &Visitor{LinkID: t.LinkID, AssetID: t.ID, Hash: hash}
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		// One link's visitors are counted and added one at a time.
		if _, err := tx.Exec(ctx, `SELECT 1 FROM public_link WHERE id = $1::uuid FOR UPDATE`, v.LinkID); err != nil {
			return err
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM public_visitor WHERE link_id = $1::uuid`, v.LinkID).Scan(&n); err != nil {
			return err
		}
		if n >= max {
			return ErrVisitorLimit
		}
		_, err := tx.Exec(ctx, `
			INSERT INTO public_visitor (link_id, visitor_hash, asset_id) VALUES ($1::uuid, $2, $3::uuid)
			ON CONFLICT DO NOTHING`, v.LinkID, hash, v.AssetID)
		return err
	})
	if err != nil {
		return nil, err
	}
	return v, nil
}

// VisitorData returns a visitor's page data.
func (s *Store) VisitorData(ctx context.Context, v *Visitor) (map[string]string, error) {
	return readPageData(ctx, s.pool, v.owner())
}

// UpdateVisitorData applies a change to a visitor's page data, all or
// nothing, with the limits of any user's. A visitor deleted meanwhile (its
// link revoked) is ErrNotFound.
func (s *Store) UpdateVisitorData(ctx context.Context, v *Visitor, c PageDataChange) error {
	if err := checkPageDataKeys(c); err != nil {
		return err
	}
	return s.inTx(ctx, func(tx pgx.Tx) error {
		var ok bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM public_visitor WHERE link_id = $1::uuid AND visitor_hash = $2 FOR SHARE)`,
			v.LinkID, v.Hash).Scan(&ok); err != nil {
			return err
		}
		if !ok {
			return ErrNotFound
		}
		return writePageData(ctx, tx, v.owner(), c)
	})
}

// DeleteIdleVisitors deletes the visitors not seen since before, with their
// page data; their backend data is left to SweepVisitorCleanup's callback.
func (s *Store) DeleteIdleVisitors(ctx context.Context, before time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM public_visitor WHERE last_seen_at < $1`, before)
	return tag.RowsAffected(), err
}

// VisitorCleanup is a visitor gone whose backend data may remain.
type VisitorCleanup struct {
	AssetID, Hash string
	// BackendData: the runner holds data for the page (its backend has been
	// called): only then is there anything to delete there.
	BackendData bool
}

// VisitorCleanups lists up to limit visitors gone, oldest first.
func (s *Store) VisitorCleanups(ctx context.Context, limit int) ([]VisitorCleanup, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT c.asset_id::text, c.visitor_hash, COALESCE(a.backend_used_at IS NOT NULL, false)
		FROM visitor_cleanup c LEFT JOIN asset a ON a.id = c.asset_id
		ORDER BY c.created_at LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (VisitorCleanup, error) {
		var c VisitorCleanup
		err := r.Scan(&c.AssetID, &c.Hash, &c.BackendData)
		return c, err
	})
}

// VisitorCleanedUp records that a gone visitor's backend data is deleted
// (or that there was none).
func (s *Store) VisitorCleanedUp(ctx context.Context, c VisitorCleanup) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM visitor_cleanup WHERE asset_id = $1::uuid AND visitor_hash = $2`, c.AssetID, c.Hash)
	return err
}
