package mcpserver

import (
	"context"
	"errors"
	"time"

	"github.com/danieles/specola/internal/store"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	createLinkDesc = `Make a public link to a page the user owns: a secret URL that shows the page, read-only, to anyone who has it, without signing in to Specola. The URL is returned only now and can't be retrieved later. The link follows the current version unless pinned to one with version, and expires after expires_in_days (at most 366) or never when that is omitted. It stops working when revoked, when the page is archived, or when its creator no longer owns the page. localStorage on a public link lasts for one load only.`
	listLinksDesc  = `List the public links on a page the user owns, newest first, with their label, pinned version, expiry, views and last use. The URLs themselves are not kept.`
	revokeLinkDesc = `Revoke a public link on a page the user owns, by the link id from list_public_links. The URL stops working at once.`
)

type createLinkIn struct {
	ID            string `json:"id" jsonschema:"id of the page"`
	Label         string `json:"label,omitempty" jsonschema:"who or what the link is for, up to 100 characters"`
	Version       int    `json:"version,omitempty" jsonschema:"pin the link to this version; follows the current version when omitted"`
	ExpiresInDays int    `json:"expires_in_days,omitempty" jsonschema:"days until the link stops working, at most 366; never expires when omitted"`
}

type createLinkOut struct {
	store.PublicLink
	URL string `json:"url" jsonschema:"the public URL; shown only now"`
}

func (t *tools) createPublicLink(ctx context.Context, req *mcp.CallToolRequest, in createLinkIn) (*mcp.CallToolResult, createLinkOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, createLinkOut{}, err
	}
	if in.ExpiresInDays < 0 {
		return nil, createLinkOut{}, errors.New("expires_in_days must be positive, or omitted for a link that never expires")
	}
	token, link, err := t.st.CreatePublicLink(ctx, who.Sub, in.ID, store.PublicLinkRequest{
		Label:   in.Label,
		Version: in.Version,
		TTL:     time.Duration(in.ExpiresInDays) * 24 * time.Hour,
	})
	if err != nil {
		return nil, createLinkOut{}, toolError(err, "page")
	}
	return nil, createLinkOut{PublicLink: *link, URL: t.opts.PublicLinkURL(token)}, nil
}

type listLinksOut struct {
	Links []store.PublicLink `json:"links"`
}

func (t *tools) listPublicLinks(ctx context.Context, req *mcp.CallToolRequest, in pageIDIn) (*mcp.CallToolResult, listLinksOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, listLinksOut{}, err
	}
	links, err := t.st.PublicLinks(ctx, who.Sub, in.ID)
	if err != nil {
		return nil, listLinksOut{}, toolError(err, "page")
	}
	return nil, listLinksOut{Links: links}, nil
}

type revokeLinkIn struct {
	ID     string `json:"id" jsonschema:"id of the page"`
	LinkID string `json:"link_id" jsonschema:"id of the public link, from list_public_links"`
}

func (t *tools) revokePublicLink(ctx context.Context, req *mcp.CallToolRequest, in revokeLinkIn) (*mcp.CallToolResult, okOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, okOut{}, err
	}
	if err := t.st.RevokePublicLink(ctx, who.Sub, in.ID, in.LinkID); err != nil {
		return nil, okOut{}, toolError(err, "page")
	}
	return nil, okOut{OK: true}, nil
}
