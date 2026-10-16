// Package mcpserver exposes Specola to AI agents as an MCP server. Every tool
// acts as the user whose access token authenticated the request, so pages an
// agent publishes land in that user's gallery.
package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/http"
	"strings"
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
	// Read-only tools say so: clients such as Hermes replay only those after a
	// dropped connection, and may skip asking the user before calling them.
	// The organising ones are idempotent: repeating one changes nothing more.
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true}
	idempotent := &mcp.ToolAnnotations{IdempotentHint: true, DestructiveHint: ptr(false)}
	additive := &mcp.ToolAnnotations{DestructiveHint: ptr(false)}

	mcp.AddTool(srv, &mcp.Tool{Name: "publish_page", Description: publishDesc, Annotations: additive}, t.publishPage)
	mcp.AddTool(srv, &mcp.Tool{Name: "new_version", Description: newVersionDesc, Annotations: additive}, t.newVersion)
	mcp.AddTool(srv, &mcp.Tool{Name: "list", Description: listDesc, Annotations: readOnly}, t.list)
	mcp.AddTool(srv, &mcp.Tool{Name: "get_page", Description: getPageDesc, Annotations: readOnly}, t.getPage)
	mcp.AddTool(srv, &mcp.Tool{Name: "list_versions", Description: listVersionsDesc, Annotations: readOnly}, t.listVersions)
	mcp.AddTool(srv, &mcp.Tool{Name: "create_upload_grant", Description: grantDesc, Annotations: additive}, t.createUploadGrant)
	mcp.AddTool(srv, &mcp.Tool{Name: "create_folder", Description: createFolderDesc, Annotations: additive}, t.createFolder)
	mcp.AddTool(srv, &mcp.Tool{Name: "rename", Description: renameDesc, Annotations: idempotent}, t.rename)
	mcp.AddTool(srv, &mcp.Tool{Name: "move", Description: moveDesc, Annotations: idempotent}, t.move)
	mcp.AddTool(srv, &mcp.Tool{Name: "archive", Description: archiveDesc, Annotations: idempotent}, t.archive)
	mcp.AddTool(srv, &mcp.Tool{Name: "unarchive", Description: unarchiveDesc, Annotations: idempotent}, t.unarchive)
	mcp.AddTool(srv, &mcp.Tool{Name: "share", Description: shareDesc, Annotations: idempotent}, t.share)
	mcp.AddTool(srv, &mcp.Tool{Name: "search", Description: searchDesc, Annotations: readOnly}, t.search)

	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		Stateless:                  true,
		JSONResponse:               true,
		MaxRequestBodyBytes:        MaxBodyBytes,
		DisableLocalhostProtection: !opts.LocalhostProtection,
	})
}

const instructions = `Specola stores versioned, interactive HTML pages in the user's own gallery.
Publish a page with publish_page, update it with new_version (each call adds a version; history is kept), and find existing pages with search or list.
Give every version a short note saying what changed; it is what the user reads in the history.
Organise with create_folder, move, rename and archive; nothing is ever deleted, and archive can be undone with unarchive.
Pages must be self-contained HTML: inline CSS and JS; imports from public CDNs are fine. Pages run in a sandbox without access to Specola itself.
For HTML over ~100 KB, don't inline it in a tool argument: call create_upload_grant and PUT the file to the returned URL with curl.`

const htmlNote = ` The HTML must be a complete, self-contained document: inline CSS and JS (CDN imports are fine). It is rendered in a sandboxed iframe. For HTML over ~100 KB use create_upload_grant instead, so the content isn't truncated.`

const (
	publishDesc    = `Publish a new HTML page to the user's Specola gallery and return its id and link.` + htmlNote
	newVersionDesc = `Replace the content of an existing page by adding a new version. Earlier versions stay in the history.` + htmlNote
	listDesc       = `List the folders and pages in a folder of the user's gallery (the user's own root when folder_id is omitted), or with shared_with_me the items other users shared with them, or with archived the items the user archived. Each item carries the user's role: owner, editor or viewer.`
	getPageDesc    = `Get a page's metadata and the HTML of its current version, or of an earlier one with version.`

	listVersionsDesc = `List a page's versions, newest first, with when each was made, by whom, its size and its note.`
	createFolderDesc = `Create a folder in the user's gallery, at the root or inside parent_id, and return its id.`
	renameDesc       = `Rename a page or folder. Needs editor access.`
	moveDesc         = `Move a page or folder into folder_id, or to the user's root when folder_id is omitted. Moving into a folder needs editor access on both; moving to the root only the item's owner may do.`
	archiveDesc      = `Archive a page or folder the user owns: it disappears from listings, links and search, for everyone it is shared with too, and a folder takes everything inside with it. Nothing is deleted; unarchive brings it back.`
	unarchiveDesc    = `Restore an archived page or folder the user owns, with everything that was inside it. list with archived shows what can be restored.`
	searchDesc       = `Full-text search over the titles and text of every page the user can see, their own and shared with them, best match first. Supports "quoted phrases", OR, and -excluded words. Matching is on whole words, without stemming.`
	shareDesc        = `Share a page or folder the user owns with another Specola user by email. role "viewer" can read, "editor" can also add versions and create items inside a folder, "none" removes the share. Sharing a folder covers everything beneath it. The other user must have signed in to Specola at least once.`
	grantDesc        = `Get a one-time URL to upload a large HTML file over plain HTTP instead of passing it as a tool argument. kind "new" publishes a new page (title required, folder_id optional); kind "version" adds a version to page id. PUT the raw HTML file as the request body (see the returned curl command) within 10 minutes; the response holds the page id, version and url.`
)

// GrantTTL is how long an upload grant stays valid.
const GrantTTL = 10 * time.Minute

type tools struct {
	st   *store.Store
	opts Options
}

func ptr[T any](v T) *T { return &v }

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
	Note     string  `json:"note,omitempty" jsonschema:"optional, one line on what this version is or what changed; shown in the page's history"`
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
	id, version, err := t.st.CreatePage(ctx, in.FolderID, in.Title, in.HTML, in.Note, who.Sub)
	if err != nil {
		return nil, publishOut{}, toolError(err, "folder")
	}
	return nil, publishOut{ID: id, Version: version, URL: t.pageURL(id)}, nil
}

type newVersionIn struct {
	ID   string `json:"id" jsonschema:"id of the page to update"`
	HTML string `json:"html" jsonschema:"complete self-contained HTML document"`
	Note string `json:"note,omitempty" jsonschema:"optional, one line on what this version is or what changed; shown in the page's history"`
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
	version, err := t.st.AddVersion(ctx, in.ID, in.HTML, in.Note, who.Sub)
	if err != nil {
		return nil, newVersionOut{}, toolError(err, "page")
	}
	return nil, newVersionOut{Version: version, URL: t.pageURL(in.ID)}, nil
}

type listIn struct {
	FolderID     *string `json:"folder_id,omitempty" jsonschema:"folder to list; the root when omitted"`
	SharedWithMe bool    `json:"shared_with_me,omitempty" jsonschema:"list the items shared with the user instead"`
	Archived     bool    `json:"archived,omitempty" jsonschema:"list the items the user archived instead"`
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
	switch {
	case in.SharedWithMe && in.Archived:
		return nil, listOut{}, errors.New("choose one of shared_with_me and archived")
	case in.SharedWithMe:
		items, err = t.st.SharedWithMe(ctx, who.Sub)
	case in.Archived:
		items, err = t.st.Archived(ctx, who.Sub)
	default:
		items, err = t.st.Tree(ctx, who.Sub, in.FolderID)
	}
	if err != nil {
		return nil, listOut{}, toolError(err, "folder")
	}
	out := listOut{Items: make([]listItem, 0, len(items))}
	for _, it := range items {
		li := listItem{TreeItem: it}
		// An archived page has no working link until it is restored.
		if it.Kind == "page" && !in.Archived {
			li.URL = t.pageURL(it.ID)
		}
		out.Items = append(out.Items, li)
	}
	return nil, out, nil
}

type getPageIn struct {
	ID      string `json:"id" jsonschema:"id of the page"`
	Version int    `json:"version,omitempty" jsonschema:"version whose HTML to return; the current one when omitted"`
}

type getPageOut struct {
	store.PageMeta
	URL         string `json:"url"`
	HTML        string `json:"html"`
	HTMLVersion int    `json:"html_version" jsonschema:"the version html belongs to; version is the current one"`
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
	v := meta.Version
	if in.Version != 0 {
		v = in.Version
	}
	html, err := t.st.VersionContent(ctx, who.Sub, in.ID, v)
	if err != nil {
		return nil, getPageOut{}, toolError(err, "page or version")
	}
	return nil, getPageOut{PageMeta: *meta, URL: t.pageURL(in.ID), HTML: html, HTMLVersion: v}, nil
}

type pageIDIn struct {
	ID string `json:"id" jsonschema:"id of the page"`
}

type listVersionsOut struct {
	Versions []store.VersionInfo `json:"versions"`
}

func (t *tools) listVersions(ctx context.Context, req *mcp.CallToolRequest, in pageIDIn) (*mcp.CallToolResult, listVersionsOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, listVersionsOut{}, err
	}
	vs, err := t.st.Versions(ctx, who.Sub, in.ID)
	if err != nil {
		return nil, listVersionsOut{}, toolError(err, "page")
	}
	return nil, listVersionsOut{Versions: vs}, nil
}

type createFolderIn struct {
	Name     string  `json:"name" jsonschema:"folder name"`
	ParentID *string `json:"parent_id,omitempty" jsonschema:"folder to create it in; the root when omitted"`
}

type createFolderOut struct {
	ID string `json:"id"`
}

func (t *tools) createFolder(ctx context.Context, req *mcp.CallToolRequest, in createFolderIn) (*mcp.CallToolResult, createFolderOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, createFolderOut{}, err
	}
	if strings.TrimSpace(in.Name) == "" {
		return nil, createFolderOut{}, errors.New("name is required")
	}
	id, err := t.st.CreateFolder(ctx, in.ParentID, strings.TrimSpace(in.Name), who.Sub)
	if err != nil {
		return nil, createFolderOut{}, toolError(err, "parent folder")
	}
	return nil, createFolderOut{ID: id}, nil
}

// itemIn names a page or folder for the organising tools.
type itemIn struct {
	Kind string `json:"kind" jsonschema:"page or folder"`
	ID   string `json:"id" jsonschema:"id of the page or folder"`
}

func (in itemIn) kind() (store.ItemKind, error) {
	k := store.ItemKind(in.Kind)
	if k != store.KindPage && k != store.KindFolder {
		return "", errors.New(`kind must be "page" or "folder"`)
	}
	return k, nil
}

type okOut struct {
	OK bool `json:"ok"`
}

// organize runs one of the item operations for the caller, mapping store
// errors to messages about the item.
func (t *tools) organize(ctx context.Context, req *mcp.CallToolRequest, in itemIn,
	op func(sub string, kind store.ItemKind) error) (*mcp.CallToolResult, okOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, okOut{}, err
	}
	kind, err := in.kind()
	if err != nil {
		return nil, okOut{}, err
	}
	if err := op(who.Sub, kind); err != nil {
		var invalid *store.ErrInvalid
		if errors.As(err, &invalid) {
			return nil, okOut{}, err
		}
		return nil, okOut{}, toolError(err, in.Kind)
	}
	return nil, okOut{OK: true}, nil
}

type renameIn struct {
	itemIn
	Name string `json:"name" jsonschema:"the new name"`
}

func (t *tools) rename(ctx context.Context, req *mcp.CallToolRequest, in renameIn) (*mcp.CallToolResult, okOut, error) {
	return t.organize(ctx, req, in.itemIn, func(sub string, kind store.ItemKind) error {
		return t.st.Rename(ctx, sub, kind, in.ID, in.Name)
	})
}

type moveIn struct {
	itemIn
	FolderID *string `json:"folder_id,omitempty" jsonschema:"destination folder; the user's root when omitted"`
}

func (t *tools) move(ctx context.Context, req *mcp.CallToolRequest, in moveIn) (*mcp.CallToolResult, okOut, error) {
	return t.organize(ctx, req, in.itemIn, func(sub string, kind store.ItemKind) error {
		return t.st.Move(ctx, sub, kind, in.ID, in.FolderID)
	})
}

func (t *tools) archive(ctx context.Context, req *mcp.CallToolRequest, in itemIn) (*mcp.CallToolResult, okOut, error) {
	return t.organize(ctx, req, in, func(sub string, kind store.ItemKind) error {
		return t.st.Archive(ctx, sub, kind, in.ID)
	})
}

func (t *tools) unarchive(ctx context.Context, req *mcp.CallToolRequest, in itemIn) (*mcp.CallToolResult, okOut, error) {
	return t.organize(ctx, req, in, func(sub string, kind store.ItemKind) error {
		return t.st.Unarchive(ctx, sub, kind, in.ID)
	})
}

type grantIn struct {
	Kind     string  `json:"kind" jsonschema:"new (publish a new page) or version (add a version to page id)"`
	Title    string  `json:"title,omitempty" jsonschema:"title of the new page; required for kind new"`
	FolderID *string `json:"folder_id,omitempty" jsonschema:"folder for the new page; the root when omitted"`
	ID       string  `json:"id,omitempty" jsonschema:"page to add a version to; required for kind version"`
	Note     string  `json:"note,omitempty" jsonschema:"optional, one line on what this version is or what changed; shown in the page's history"`
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
	gr := store.GrantRequest{Sub: who.Sub, Note: in.Note}
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

type searchIn struct {
	Query string `json:"query" jsonschema:"words to search for"`
	Limit int    `json:"limit,omitempty" jsonschema:"maximum results, default 20, at most 100"`
}

type searchHit struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Version int    `json:"version"`
	Role    string `json:"role"`
	URL     string `json:"url"`
	Snippet string `json:"snippet" jsonschema:"matching text, matches wrapped in <mark>"`
}

type searchOut struct {
	Results []searchHit `json:"results"`
}

func (t *tools) search(ctx context.Context, req *mcp.CallToolRequest, in searchIn) (*mcp.CallToolResult, searchOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, searchOut{}, err
	}
	res, err := t.st.Search(ctx, who.Sub, in.Query, in.Limit)
	if err != nil {
		return nil, searchOut{}, err
	}
	out := searchOut{Results: make([]searchHit, 0, len(res))}
	for _, r := range res {
		out.Results = append(out.Results, searchHit{
			ID: r.ID, Name: r.Name, Version: r.Version, Role: r.Role,
			URL: t.pageURL(r.ID), Snippet: html.UnescapeString(r.Snippet),
		})
	}
	return nil, out, nil
}
