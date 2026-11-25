package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// Upload grants let a client move a large HTML body over plain HTTP instead of
// inlining it in an MCP tool argument. A grant is a random token, of which only
// the sha256 is stored; it is single-use and short-lived, and redeeming it
// re-checks that the minting user still has access.

// Grant kinds, as stored in asset_grant.kind.
const (
	GrantUploadNew     = "UPLOAD_NEW"
	GrantUploadVersion = "UPLOAD_VERSION"
)

var (
	// ErrGrantGone means the grant was already used or has expired.
	ErrGrantGone = errors.New("grant already used or expired")
	// ErrGrantKind means the grant can't be used for this operation.
	ErrGrantKind = errors.New("grant is not valid for this operation")
)

// GrantRequest describes what a new grant allows.
type GrantRequest struct {
	Kind string // GrantUploadNew or GrantUploadVersion
	Sub  string // the minting user; the upload acts as them
	// For GrantUploadNew: the page name and optional folder.
	Name     string
	FolderID *string
	// For GrantUploadVersion: the page to add a version to.
	AssetID string
	// Optional note for the version the upload creates (see CleanNote).
	Note string
	// Bundle makes it a bundle upload grant, used through the multi-step
	// bundle upload (see bundles.go) instead of RedeemUpload.
	Bundle bool
}

// MintGrant checks that req.Sub may perform the upload now, then stores a new
// grant valid for ttl and returns its token.
func (s *Store) MintGrant(ctx context.Context, req GrantRequest, ttl time.Duration) (token string, expires time.Time, err error) {
	note, err := CleanNote(req.Note)
	if err != nil {
		return "", time.Time{}, err
	}
	var assetID *string
	switch req.Kind {
	case GrantUploadNew:
		if req.Name == "" {
			return "", time.Time{}, errors.New("name is required")
		}
		if err := checkFolder(ctx, s.pool, req.FolderID, req.Sub, RoleEditor); err != nil {
			return "", time.Time{}, err
		}
	case GrantUploadVersion:
		if err := checkPage(ctx, s.pool, req.AssetID, req.Sub, RoleEditor); err != nil {
			return "", time.Time{}, err
		}
		assetID = &req.AssetID
	default:
		return "", time.Time{}, ErrGrantKind
	}

	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", time.Time{}, err
	}
	token = base64.RawURLEncoding.EncodeToString(b)
	err = s.pool.QueryRow(ctx, `
		INSERT INTO asset_grant (kind, secret_hash, asset_id, folder_id, name, created_by_sub, expires_at, note, bundle)
		VALUES ($1, $2, $3::uuid, $4::uuid, NULLIF($5, ''), $6, now() + make_interval(secs => $7), $8, $9)
		RETURNING expires_at`,
		req.Kind, hashToken(token), assetID, req.FolderID, req.Name, req.Sub, ttl.Seconds(), note, req.Bundle).Scan(&expires)
	if err != nil {
		return "", time.Time{}, err
	}
	return token, expires, nil
}

// RedeemUpload uses an upload grant: it creates the page or adds the version
// as the minting user, and marks the grant consumed, all in one transaction.
// It returns ErrNotFound for an unknown token or when the user has lost access
// to the target (ErrForbidden if they can still see it but no longer edit),
// ErrGrantGone for a used or expired grant, and ErrGrantKind for a grant that
// isn't a plain upload.
func (s *Store) RedeemUpload(ctx context.Context, token, html string) (id string, version int, err error) {
	err = s.inTx(ctx, func(tx pgx.Tx) error {
		g, err := openGrant(ctx, tx, token, true)
		if err != nil {
			return err
		}
		// A bundle grant is redeemed through the bundle upload steps.
		if g.bundle {
			return ErrGrantKind
		}
		switch {
		case g.kind == GrantUploadNew && g.name != nil:
			id, version, err = createPage(ctx, tx, g.folderID, *g.name, html, g.note, g.sub)
		case g.kind == GrantUploadVersion && g.assetID != nil:
			id = *g.assetID
			version, err = addVersion(ctx, tx, id, html, g.note, g.sub, nil)
			if err == nil {
				// A plain version: the page's scheduled jobs end (cron.go).
				err = syncBackendCron(ctx, tx, id, time.Now())
			}
		default:
			return ErrGrantKind
		}
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE asset_grant SET consumed_at = now() WHERE id = $1::uuid`, g.id)
		return err
	})
	if err != nil {
		return "", 0, err
	}
	return id, version, nil
}

// SweepGrants deletes grants that expired more than grace ago. The grace keeps
// recently expired tokens around so redeeming one reports "expired" rather
// than "unknown".
func (s *Store) SweepGrants(ctx context.Context, grace time.Duration) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM asset_grant WHERE expires_at < now() - make_interval(secs => $1)`, grace.Seconds())
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
