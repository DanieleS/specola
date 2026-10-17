package store

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Public links show a page, read-only, to anyone holding the link, without
// signing in. Only a page's owner can create, list or revoke them. Like upload
// grants, a link is a random token of which only the sha256 is stored, so the
// URL is shown once, when it is made. Opening one re-checks that its creator
// still owns the page and that the page is active, so archiving the page (or
// a folder above it) takes its links down with it, and unarchiving brings them
// back. Revoking deletes the link.

// ErrLinkExpired means a public link is past its expiry.
var ErrLinkExpired = errors.New("this link has expired")

const (
	// MaxLinkLabelRunes bounds a link's label: a few words on who it is for.
	MaxLinkLabelRunes = 100
	// MaxLinkTTL bounds how long a link can be made to last; a link can also
	// be made to never expire.
	MaxLinkTTL = 366 * 24 * time.Hour
)

// PublicLink is one public link on a page, as its owner sees it. The token
// itself is not kept.
type PublicLink struct {
	ID string `json:"id"`
	// Version the link is pinned to; nil follows the current version.
	Version    *int       `json:"version,omitempty"`
	Label      string     `json:"label,omitempty"`
	CreatedBy  string     `json:"createdBy,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	ExpiresAt  *time.Time `json:"expiresAt,omitempty"`
	Expired    bool       `json:"expired"`
	LastUsedAt *time.Time `json:"lastUsedAt,omitempty"`
	Views      int64      `json:"views"`
}

// PublicLinkRequest describes a new public link.
type PublicLinkRequest struct {
	Label string
	// Version pins the link to one version; 0 follows the current one.
	Version int
	// TTL is how long the link works; 0 means it never expires.
	TTL time.Duration
}

// CreatePublicLink makes a public link on a page sub owns and returns its
// token, which is not stored and can't be had again.
func (s *Store) CreatePublicLink(ctx context.Context, sub, assetID string, req PublicLinkRequest) (string, *PublicLink, error) {
	label := strings.TrimSpace(req.Label)
	if utf8.RuneCountInString(label) > MaxLinkLabelRunes {
		return "", nil, &ErrInvalid{fmt.Sprintf("label is longer than %d characters", MaxLinkLabelRunes)}
	}
	if req.TTL < 0 || req.TTL > MaxLinkTTL {
		return "", nil, &ErrInvalid{"a link can last at most a year, or never expire"}
	}
	if err := s.needOwner(ctx, sub, KindPage, assetID); err != nil {
		return "", nil, err
	}
	var version *int
	if req.Version != 0 {
		var current int
		if err := s.pool.QueryRow(ctx, `SELECT current_version FROM asset WHERE id = $1::uuid`, assetID).Scan(&current); err != nil {
			return "", nil, err
		}
		if req.Version < 1 || req.Version > current {
			return "", nil, &ErrInvalid{fmt.Sprintf("version must be between 1 and %d", current)}
		}
		version = &req.Version
	}
	var expires *time.Time
	if req.TTL > 0 {
		t := time.Now().Add(req.TTL)
		expires = &t
	}

	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", nil, err
	}
	token := base64.RawURLEncoding.EncodeToString(b)
	l := PublicLink{Version: version, Label: label, ExpiresAt: expires}
	err := s.pool.QueryRow(ctx, `
		INSERT INTO public_link (asset_id, secret_hash, version, label, created_by_sub, expires_at)
		VALUES ($1::uuid, $2, $3, NULLIF($4, ''), $5, $6)
		RETURNING id::text, created_at`,
		assetID, hashToken(token), version, label, sub, expires).Scan(&l.ID, &l.CreatedAt)
	if err != nil {
		return "", nil, err
	}
	l.CreatedBy = sub
	_ = s.pool.QueryRow(ctx, `SELECT email FROM app_user WHERE sub = $1 AND email IS NOT NULL`, sub).Scan(&l.CreatedBy)
	return token, &l, nil
}

// PublicLinks lists the public links on a page sub owns, newest first,
// expired ones included.
func (s *Store) PublicLinks(ctx context.Context, sub, assetID string) ([]PublicLink, error) {
	if err := s.needOwner(ctx, sub, KindPage, assetID); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT l.id::text, l.version, COALESCE(l.label, ''), COALESCE(u.email, l.created_by_sub),
		       l.created_at, l.expires_at, l.expires_at IS NOT NULL AND l.expires_at <= now(),
		       l.last_used_at, l.views
		FROM public_link l LEFT JOIN app_user u ON u.sub = l.created_by_sub
		WHERE l.asset_id = $1::uuid
		ORDER BY l.created_at DESC`, assetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PublicLink{}
	for rows.Next() {
		var l PublicLink
		if err := rows.Scan(&l.ID, &l.Version, &l.Label, &l.CreatedBy, &l.CreatedAt, &l.ExpiresAt, &l.Expired, &l.LastUsedAt, &l.Views); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// RevokePublicLink deletes a public link on a page sub owns. Revoking a link
// that is already gone is not an error.
func (s *Store) RevokePublicLink(ctx context.Context, sub, assetID, linkID string) error {
	if err := s.needOwner(ctx, sub, KindPage, assetID); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM public_link WHERE id = $1::uuid AND asset_id = $2::uuid`, linkID, assetID)
	if isInvalidText(err) {
		return nil
	}
	return err
}

// OpenPublicLink returns the HTML a public link shows, and counts the view.
// It returns ErrNotFound for an unknown or revoked token, or when the page is
// archived or its creator no longer owns it, and ErrLinkExpired for an
// expired link.
func (s *Store) OpenPublicLink(ctx context.Context, token string) (string, error) {
	var (
		linkID, assetID string
		version         int
		expired, owner  bool
	)
	err := s.pool.QueryRow(ctx, `
		SELECT l.id::text, l.asset_id::text, COALESCE(l.version, a.current_version),
		       l.expires_at IS NOT NULL AND l.expires_at <= now(),
		       asset_access(l.created_by_sub, a.id) = 3
		FROM public_link l JOIN asset a ON a.id = l.asset_id
		WHERE l.secret_hash = $1`, hashToken(token)).Scan(&linkID, &assetID, &version, &expired, &owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if !owner {
		return "", ErrNotFound
	}
	if expired {
		return "", ErrLinkExpired
	}
	html, err := versionContent(ctx, s.pool, assetID, version)
	if err != nil {
		return "", err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE public_link SET views = views + 1, last_used_at = now() WHERE id = $1::uuid`, linkID); err != nil {
		return "", err
	}
	return html, nil
}

// hasPublicLinks is the SQL for "page a has a public link that hasn't
// expired".
const hasPublicLinks = `EXISTS (SELECT 1 FROM public_link l WHERE l.asset_id = a.id AND (l.expires_at IS NULL OR l.expires_at > now()))`
