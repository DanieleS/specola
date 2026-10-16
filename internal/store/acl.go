package store

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// Shares are acl_entry rows: one subject, one role, on a folder xor a page. Only
// an item's owner can list or change them.

// ErrUnknownUser means no user with that email has signed in yet, so there is
// no sub to share with.
var ErrUnknownUser = errors.New("no user with that email has signed in to Specola yet")

// ErrSelfShare means the owner tried to share an item with themselves.
var ErrSelfShare = errors.New("you already own this item")

// ItemKind names the two kinds of shareable items.
type ItemKind string

const (
	KindFolder ItemKind = "folder"
	KindPage   ItemKind = "page"
)

// column is the acl_entry column naming an item of this kind.
func (k ItemKind) column() string {
	if k == KindFolder {
		return "folder_id"
	}
	return "asset_id"
}

func (k ItemKind) role(ctx context.Context, q querier, id, sub string) (Role, error) {
	if k == KindFolder {
		return folderRole(ctx, q, id, sub)
	}
	return pageRole(ctx, q, id, sub)
}

// Share is one subject's access to an item.
type Share struct {
	Sub       string    `json:"sub"`
	Email     string    `json:"email,omitempty"`
	Name      string    `json:"name,omitempty"`
	Role      string    `json:"role"` // viewer or editor
	CreatedAt time.Time `json:"createdAt"`
}

// Shares lists who an item is shared with. sub must own it.
func (s *Store) Shares(ctx context.Context, sub string, kind ItemKind, id string) ([]Share, error) {
	if err := s.needOwner(ctx, sub, kind, id); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT e.subject_sub, COALESCE(u.email, ''), COALESCE(u.name, ''),
		       CASE e.role WHEN 'EDITOR' THEN 2 ELSE 1 END, e.created_at
		FROM acl_entry e LEFT JOIN app_user u ON u.sub = e.subject_sub
		WHERE e.`+kind.column()+` = $1::uuid
		ORDER BY e.created_at`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Share{}
	for rows.Next() {
		var sh Share
		var r Role
		if err := rows.Scan(&sh.Sub, &sh.Email, &sh.Name, &r, &sh.CreatedAt); err != nil {
			return nil, err
		}
		sh.Role = r.String()
		out = append(out, sh)
	}
	return out, rows.Err()
}

// Share gives subject the role on an item, replacing any role they had on it.
// sub must own the item.
func (s *Store) Share(ctx context.Context, sub string, kind ItemKind, id, subject string, role Role) error {
	if role != RoleViewer && role != RoleEditor {
		return errors.New("role must be viewer or editor")
	}
	if err := s.needOwner(ctx, sub, kind, id); err != nil {
		return err
	}
	if subject == sub {
		return ErrSelfShare
	}
	col := kind.column()
	_, err := s.pool.Exec(ctx, `
		INSERT INTO acl_entry (`+col+`, subject_sub, role, created_by_sub)
		VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (`+col+`, subject_sub) WHERE `+col+` IS NOT NULL
		DO UPDATE SET role = EXCLUDED.role`, id, subject, role.aclRole(), sub)
	return err
}

// Unshare removes subject's share on an item. sub must own the item. Removing
// a share that doesn't exist is not an error.
func (s *Store) Unshare(ctx context.Context, sub string, kind ItemKind, id, subject string) error {
	if err := s.needOwner(ctx, sub, kind, id); err != nil {
		return err
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM acl_entry WHERE `+kind.column()+` = $1::uuid AND subject_sub = $2`, id, subject)
	return err
}

// UserByEmail resolves an email to the sub of the user who most recently
// signed in with it.
func (s *Store) UserByEmail(ctx context.Context, email string) (string, error) {
	var sub string
	err := s.pool.QueryRow(ctx, `
		SELECT sub FROM app_user WHERE lower(email) = lower($1)
		ORDER BY last_login_at DESC LIMIT 1`, strings.TrimSpace(email)).Scan(&sub)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrUnknownUser
	}
	return sub, err
}

func (s *Store) needOwner(ctx context.Context, sub string, kind ItemKind, id string) error {
	r, err := kind.role(ctx, s.pool, id, sub)
	if err != nil {
		return err
	}
	return need(r, RoleOwner)
}
