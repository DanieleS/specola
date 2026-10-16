package store

import (
	"context"
	"errors"
)

// Access: a user's Role on a folder or page comes from the folder_access and
// asset_access SQL functions (migration 0003): owner if they created the item
// or a folder above it, otherwise the nearest share up the folder chain. Every
// read and write in this package checks it. An item the caller can't see is
// reported as ErrNotFound so its existence isn't leaked; one they can see but
// not change is ErrForbidden.

// Role is a user's access level on an item; higher includes lower.
type Role int

const (
	RoleNone Role = iota
	RoleViewer
	RoleEditor
	RoleOwner
)

var ErrForbidden = errors.New("forbidden")

func (r Role) String() string {
	switch r {
	case RoleViewer:
		return "viewer"
	case RoleEditor:
		return "editor"
	case RoleOwner:
		return "owner"
	default:
		return "none"
	}
}

// ParseShareRole parses a role that can be granted: "viewer" or "editor".
func ParseShareRole(s string) (Role, bool) {
	switch s {
	case "viewer":
		return RoleViewer, true
	case "editor":
		return RoleEditor, true
	}
	return RoleNone, false
}

// aclRole is the acl_role enum value for a grantable role.
func (r Role) aclRole() string {
	if r == RoleEditor {
		return "EDITOR"
	}
	return "VIEWER"
}

// need turns a role into an error unless it is at least min.
func need(have, min Role) error {
	switch {
	case have >= min:
		return nil
	case have == RoleNone:
		return ErrNotFound
	default:
		return ErrForbidden
	}
}

// folderRole returns sub's role on an active folder; RoleNone when the folder
// is missing, archived, deleted, or the id is malformed.
func folderRole(ctx context.Context, q querier, id, sub string) (Role, error) {
	var r Role
	err := q.QueryRow(ctx, `
		SELECT COALESCE(MAX(folder_access($2, id)), 0) FROM folder
		WHERE id = $1::uuid AND deleted_at IS NULL AND archived_at IS NULL`, id, sub).Scan(&r)
	if isInvalidText(err) {
		return RoleNone, nil
	}
	return r, err
}

// pageRole is folderRole for pages.
func pageRole(ctx context.Context, q querier, id, sub string) (Role, error) {
	var r Role
	err := q.QueryRow(ctx, `
		SELECT COALESCE(MAX(asset_access($2, id)), 0) FROM asset
		WHERE id = $1::uuid AND deleted_at IS NULL AND archived_at IS NULL`, id, sub).Scan(&r)
	if isInvalidText(err) {
		return RoleNone, nil
	}
	return r, err
}

// checkFolder checks that sub has at least min on folderID. The root (nil) is
// every user's own.
func checkFolder(ctx context.Context, q querier, folderID *string, sub string, min Role) error {
	if folderID == nil {
		return nil
	}
	r, err := folderRole(ctx, q, *folderID, sub)
	if err != nil {
		return err
	}
	return need(r, min)
}

// checkPage checks that sub has at least min on page id.
func checkPage(ctx context.Context, q querier, id, sub string, min Role) error {
	r, err := pageRole(ctx, q, id, sub)
	if err != nil {
		return err
	}
	return need(r, min)
}
