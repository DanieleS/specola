// Package mcpserver exposes Specola to AI agents as an MCP server. Every tool
// acts as the user whose access token authenticated the request, so pages an
// agent publishes land in that user's gallery.
package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/danieles/specola/internal/auth"
	"github.com/danieles/specola/internal/store"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MaxBodyBytes bounds a single MCP request, which carries inline HTML.
const MaxBodyBytes = 32 << 20

// Options configure the MCP server.
type Options struct {
	// BaseURL is Specola's public origin, used to build page links.
	BaseURL string
	// OnUser, when set, is called with the caller's identity on every tool
	// call, e.g. to record the user.
	OnUser func(ctx context.Context, id auth.Identity)
	// LocalhostProtection keeps the SDK's DNS-rebinding check. Only needed
	// without bearer auth; behind a reverse proxy on loopback it rejects
	// every request, since the Host header is the public name.
	LocalhostProtection bool
}

// Handler returns the streamable-HTTP MCP endpoint. It must sit behind
// middleware that puts the caller's TokenInfo in the request (the SDK's
// auth.RequireBearerToken); UserID is the caller's sub.
func Handler(st *store.Store, opts Options) http.Handler {
	t := &tools{st: st, opts: opts}
	srv := mcp.NewServer(&mcp.Implementation{Name: "specola", Title: "Specola", Version: "0.1.0"}, &mcp.ServerOptions{
		Instructions: instructions,
	})
	mcp.AddTool(srv, &mcp.Tool{Name: "publish_page", Description: publishDesc}, t.publishPage)
	mcp.AddTool(srv, &mcp.Tool{Name: "new_version", Description: newVersionDesc}, t.newVersion)
	mcp.AddTool(srv, &mcp.Tool{Name: "list", Description: listDesc}, t.list)
	mcp.AddTool(srv, &mcp.Tool{Name: "get_page", Description: getPageDesc}, t.getPage)
	mcp.AddTool(srv, &mcp.Tool{Name: "create_upload_grant", Description: grantDesc}, t.createUploadGrant)
	mcp.AddTool(srv, &mcp.Tool{Name: "share", Description: shareDesc}, t.share)

	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		Stateless:                  true,
		JSONResponse:               true,
		MaxRequestBodyBytes:        MaxBodyBytes,
		DisableLocalhostProtection: !opts.LocalhostProtection,
	})
}

const instructions = `Specola stores versioned, interactive HTML pages in the user's own gallery.
Publish a page with publish_page, update it with new_version (each call adds a version; history is kept), and find existing pages with list.
Pages must be self-contained HTML: inline CSS and JS; imports from public CDNs are fine. Pages run in a sandbox without access to Specola itself.
For HTML over ~100 KB, don't inline it in a tool argument: call create_upload_grant and PUT the file to the returned URL with curl.`

const htmlNote = ` The HTML must be a complete, self-contained document: inline CSS and JS (CDN imports are fine). It is rendered in a sandboxed iframe. For HTML over ~100 KB use create_upload_grant instead, so the content isn't truncated.`

const (
	publishDesc    = `Publish a new HTML page to the user's Specola gallery and return its id and link.` + htmlNote
	newVersionDesc = `Replace the content of an existing page by adding a new version. Earlier versions stay in the history.` + htmlNote
	listDesc       = `List the folders and pages in a folder of the user's gallery (the user's own root when folder_id is omitted), or with shared_with_me the items other users shared with them. Each item carries the user's role: owner, editor or viewer.`
	getPageDesc    = `Get a page's metadata and the HTML of its current version.`
	shareDesc      = `Share a page or folder the user owns with another Specola user by email. role "viewer" can read, "editor" can also add versions and create items inside a folder, "none" removes the share. Sharing a folder covers everything beneath it. The other user must have signed in to Specola at least once.`
	grantDesc      = `Get a one-time URL to upload a large HTML file over plain HTTP instead of passing it as a tool argument. kind "new" publishes a new page (title required, folder_id optional); kind "version" adds a version to page id. PUT the raw HTML file as the request body (see the returned curl command) within 10 minutes; the response holds the page id, version and url.`
)

// GrantTTL is how long an upload grant stays valid.
const GrantTTL = 10 * time.Minute

type tools struct {
	st   *store.Store
	opts Options
}

// caller returns the identity the request authenticated as.
func (t *tools) caller(ctx context.Context, req *mcp.CallToolRequest) (auth.Identity, error) {
	if req.Extra == nil || req.Extra.TokenInfo == nil || req.Extra.TokenInfo.UserID == "" {
		return auth.Identity{}, errors.New("unauthenticated")
	}
	id := auth.Identity{Sub: req.Extra.TokenInfo.UserID}
	id.Email, _ = req.Extra.TokenInfo.Extra["email"].(string)
	if t.opts.OnUser != nil {
		t.opts.OnUser(ctx, id)
	}
	return id, nil
}

func (t *tools) pageURL(id string) string { return t.opts.BaseURL + "/#/p/" + id }

// toolError maps store errors to messages an agent can act on.
func toolError(err error, what string) error {
	switch {
	case errors.Is(err, store.ErrNotFound):
		return fmt.Errorf("%s not found", what)
	case errors.Is(err, store.ErrForbidden):
		return fmt.Errorf("the user has access to this %s but not enough to do that", what)
	}
	return err
}

type publishIn struct {
	Title    string  `json:"title" jsonschema:"page title shown in the gallery"`
	HTML     string  `json:"html" jsonschema:"complete self-contained HTML document"`
	FolderID *string `json:"folder_id,omitempty" jsonschema:"folder to publish into; the root when omitted"`
}

type publishOut struct {
	ID      string `json:"id"`
	Version int    `json:"version"`
	URL     string `json:"url"`
}

func (t *tools) publishPage(ctx context.Context, req *mcp.CallToolRequest, in publishIn) (*mcp.CallToolResult, publishOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, publishOut{}, err
	}
	if in.Title == "" || in.HTML == "" {
		return nil, publishOut{}, errors.New("title and html are required")
	}
	id, version, err := t.st.CreatePage(ctx, in.FolderID, in.Title, in.HTML, who.Sub)
	if err != nil {
		return nil, publishOut{}, toolError(err, "folder")
	}
	return nil, publishOut{ID: id, Version: version, URL: t.pageURL(id)}, nil
}

type newVersionIn struct {
	ID   string `json:"id" jsonschema:"id of the page to update"`
	HTML string `json:"html" jsonschema:"complete self-contained HTML document"`
}

type newVersionOut struct {
	Version int    `json:"version"`
	URL     string `json:"url"`
}

func (t *tools) newVersion(ctx context.Context, req *mcp.CallToolRequest, in newVersionIn) (*mcp.CallToolResult, newVersionOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, newVersionOut{}, err
	}
	if in.ID == "" || in.HTML == "" {
		return nil, newVersionOut{}, errors.New("id and html are required")
	}
	version, err := t.st.AddVersion(ctx, in.ID, in.HTML, who.Sub)
	if err != nil {
		return nil, newVersionOut{}, toolError(err, "page")
	}
	return nil, newVersionOut{Version: version, URL: t.pageURL(in.ID)}, nil
}

type listIn struct {
	FolderID     *string `json:"folder_id,omitempty" jsonschema:"folder to list; the root when omitted"`
	SharedWithMe bool    `json:"shared_with_me,omitempty" jsonschema:"list the items shared with the user instead"`
}

type listItem struct {
	store.TreeItem
	URL string `json:"url,omitempty"`
}

type listOut struct {
	Items []listItem `json:"items"`
}

func (t *tools) list(ctx context.Context, req *mcp.CallToolRequest, in listIn) (*mcp.CallToolResult, listOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, listOut{}, err
	}
	var items []store.TreeItem
	if in.SharedWithMe {
		items, err = t.st.SharedWithMe(ctx, who.Sub)
	} else {
		items, err = t.st.Tree(ctx, who.Sub, in.FolderID)
	}
	if err != nil {
		return nil, listOut{}, toolError(err, "folder")
	}
	out := listOut{Items: make([]listItem, 0, len(items))}
	for _, it := range items {
		li := listItem{TreeItem: it}
		if it.Kind == "page" {
			li.URL = t.pageURL(it.ID)
		}
		out.Items = append(out.Items, li)
	}
	return nil, out, nil
}

type getPageIn struct {
	ID string `json:"id" jsonschema:"id of the page"`
}

type getPageOut struct {
	store.PageMeta
	URL  string `json:"url"`
	HTML string `json:"html"`
}

func (t *tools) getPage(ctx context.Context, req *mcp.CallToolRequest, in getPageIn) (*mcp.CallToolResult, getPageOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, getPageOut{}, err
	}
	meta, err := t.st.PageMeta(ctx, who.Sub, in.ID)
	if err != nil {
		return nil, getPageOut{}, toolError(err, "page")
	}
	html, err := t.st.CurrentContent(ctx, who.Sub, in.ID)
	if err != nil {
		return nil, getPageOut{}, toolError(err, "page")
	}
	return nil, getPageOut{PageMeta: *meta, URL: t.pageURL(in.ID), HTML: html}, nil
}

type grantIn struct {
	Kind     string  `json:"kind" jsonschema:"new (publish a new page) or version (add a version to page id)"`
	Title    string  `json:"title,omitempty" jsonschema:"title of the new page; required for kind new"`
	FolderID *string `json:"folder_id,omitempty" jsonschema:"folder for the new page; the root when omitted"`
	ID       string  `json:"id,omitempty" jsonschema:"page to add a version to; required for kind version"`
}

type grantOut struct {
	UploadURL string    `json:"upload_url"`
	Method    string    `json:"method"`
	ExpiresAt time.Time `json:"expires_at"`
	Curl      string    `json:"curl"`
}

func (t *tools) createUploadGrant(ctx context.Context, req *mcp.CallToolRequest, in grantIn) (*mcp.CallToolResult, grantOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, grantOut{}, err
	}
	gr := store.GrantRequest{Sub: who.Sub}
	var what string
	switch in.Kind {
	case "new":
		if in.Title == "" {
			return nil, grantOut{}, errors.New("title is required for kind new")
		}
		gr.Kind, gr.Name, gr.FolderID, what = store.GrantUploadNew, in.Title, in.FolderID, "folder"
	case "version":
		if in.ID == "" {
			return nil, grantOut{}, errors.New("id is required for kind version")
		}
		gr.Kind, gr.AssetID, what = store.GrantUploadVersion, in.ID, "page"
	default:
		return nil, grantOut{}, errors.New(`kind must be "new" or "version"`)
	}
	token, expires, err := t.st.MintGrant(ctx, gr, GrantTTL)
	if err != nil {
		return nil, grantOut{}, toolError(err, what)
	}
	url := t.opts.BaseURL + "/upload/" + token
	return nil, grantOut{
		UploadURL: url,
		Method:    http.MethodPut,
		ExpiresAt: expires,
		Curl:      fmt.Sprintf("curl -sS -X PUT -H 'Content-Type: text/html' --data-binary @page.html '%s'", url),
	}, nil
}

type shareIn struct {
	Kind  string `json:"kind" jsonschema:"page or folder"`
	ID    string `json:"id" jsonschema:"id of the page or folder"`
	Email string `json:"email" jsonschema:"email of the user to share with"`
	Role  string `json:"role" jsonschema:"viewer, editor, or none to remove the share"`
}

type shareOut struct {
	Shares []store.Share `json:"shares"`
}

func (t *tools) share(ctx context.Context, req *mcp.CallToolRequest, in shareIn) (*mcp.CallToolResult, shareOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, shareOut{}, err
	}
	kind := store.ItemKind(in.Kind)
	if kind != store.KindPage && kind != store.KindFolder {
		return nil, shareOut{}, errors.New(`kind must be "page" or "folder"`)
	}
	subject, err := t.st.UserByEmail(ctx, in.Email)
	if err != nil {
		return nil, shareOut{}, err
	}
	if in.Role == "none" {
		err = t.st.Unshare(ctx, who.Sub, kind, in.ID, subject)
	} else if role, ok := store.ParseShareRole(in.Role); ok {
		err = t.st.Share(ctx, who.Sub, kind, in.ID, subject, role)
	} else {
		return nil, shareOut{}, errors.New(`role must be "viewer", "editor" or "none"`)
	}
	if err != nil {
		return nil, shareOut{}, toolError(err, in.Kind)
	}
	shares, err := t.st.Shares(ctx, who.Sub, kind, in.ID)
	if err != nil {
		return nil, shareOut{}, toolError(err, in.Kind)
	}
	return nil, shareOut{Shares: shares}, nil
}
