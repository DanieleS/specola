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
	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/plugin"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// MaxBodyBytes bounds a single MCP request, which carries inline HTML.
const MaxBodyBytes = 32 << 20

// Options configure the MCP server.
type Options struct {
	// BaseURL is Specola's public origin, used to build page links.
	BaseURL string
	// PublicLinkURL builds the URL of a public link from its token.
	PublicLinkURL func(token string) string
	// OnUser, when set, is called with the caller's identity on every tool
	// call, e.g. to record the user.
	OnUser func(ctx context.Context, id auth.Identity)
	// PluginURL is where this instance serves the Vite plugin's npm package,
	// which the instructions tell agents to install.
	PluginURL string
	// BundleBase is the URL a bundle's files are served under, from its key.
	BundleBase func(key string) string
	// Backends is the instance's page backend state; nil means disabled.
	// Whether they are enabled is fixed at start, so tool descriptions
	// follow it; whether the runner is available is read when needed.
	Backends func() BackendState
	// Runner is the backend runner's client, nil when backends are
	// disabled: backend_logs and backend_query ask it.
	Runner *backend.Runner
	// CallBackend is how call_backend calls a page's backend as the user
	// (backendtools.go); nil when backends are disabled.
	CallBackend CallBackendFunc
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
	backends := opts.backends()
	srv := mcp.NewServer(&mcp.Implementation{Name: "specola", Title: "Specola", Version: "0.1.0"}, &mcp.ServerOptions{
		Instructions: instructions(opts, nil, ""),
	})
	// The instructions sent at initialize carry the user's preferences.
	srv.AddReceivingMiddleware(t.personalize)
	// Read-only tools say so: clients such as Hermes replay only those after a
	// dropped connection, and may skip asking the user before calling them.
	// The organising ones are idempotent: repeating one changes nothing more.
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true}
	idempotent := &mcp.ToolAnnotations{IdempotentHint: true, DestructiveHint: ptr(false)}
	additive := &mcp.ToolAnnotations{DestructiveHint: ptr(false)}

	mcp.AddTool(srv, &mcp.Tool{Name: "publish_page", Description: publishDesc, Annotations: additive}, t.publishPage)
	mcp.AddTool(srv, &mcp.Tool{Name: "new_version", Description: newVersionDesc, Annotations: additive}, t.newVersion)
	mcp.AddTool(srv, &mcp.Tool{Name: "list", Description: listDesc, Annotations: readOnly}, t.list)
	mcp.AddTool(srv, &mcp.Tool{Name: "get_page", Description: getPageDesc(backends), Annotations: readOnly}, t.getPage)
	mcp.AddTool(srv, &mcp.Tool{Name: "list_versions", Description: listVersionsDesc(backends), Annotations: readOnly}, t.listVersions)
	mcp.AddTool(srv, &mcp.Tool{Name: "create_upload_grant", Description: grantDesc, Annotations: additive}, t.createUploadGrant)
	mcp.AddTool(srv, &mcp.Tool{Name: "create_bundle_upload", Description: bundleUploadDesc(opts.PluginURL, backends), Annotations: additive}, t.createBundleUpload)
	mcp.AddTool(srv, &mcp.Tool{Name: "create_folder", Description: createFolderDesc, Annotations: additive}, t.createFolder)
	mcp.AddTool(srv, &mcp.Tool{Name: "rename", Description: renameDesc, Annotations: idempotent}, t.rename)
	mcp.AddTool(srv, &mcp.Tool{Name: "move", Description: moveDesc, Annotations: idempotent}, t.move)
	mcp.AddTool(srv, &mcp.Tool{Name: "archive", Description: archiveDesc, Annotations: idempotent}, t.archive)
	mcp.AddTool(srv, &mcp.Tool{Name: "unarchive", Description: unarchiveDesc, Annotations: idempotent}, t.unarchive)
	mcp.AddTool(srv, &mcp.Tool{Name: "share", Description: shareDesc, Annotations: idempotent}, t.share)
	mcp.AddTool(srv, &mcp.Tool{Name: "search", Description: searchDesc, Annotations: readOnly}, t.search)
	mcp.AddTool(srv, &mcp.Tool{Name: "create_public_link", Description: createLinkDesc, Annotations: additive}, t.createPublicLink)
	mcp.AddTool(srv, &mcp.Tool{Name: "list_public_links", Description: listLinksDesc, Annotations: readOnly}, t.listPublicLinks)
	mcp.AddTool(srv, &mcp.Tool{Name: "revoke_public_link", Description: revokeLinkDesc, Annotations: &mcp.ToolAnnotations{IdempotentHint: true}}, t.revokePublicLink)
	if backends.Enabled {
		t.registerBackendTools(srv)
	}

	return mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{
		Stateless:                  true,
		JSONResponse:               true,
		MaxRequestBodyBytes:        MaxBodyBytes,
		DisableLocalhostProtection: !opts.LocalhostProtection,
	})
}

// instructions steer an agent to the right way to publish: a single HTML
// document through the tools, or anything with a build step as a bundle with
// the Vite plugin served at opts.PluginURL. Choosing well is the point: an app
// squeezed into one HTML file loses lazy loading, workers and its assets.
// p are the preferences of the user, named who, the instructions are for; nil
// for none (preferences.go).
func instructions(opts Options, p *store.Preferences, who string) string {
	mode := ""
	if p != nil && p.Mode == store.ModeBundle {
		mode = alwaysBundle
	}
	personal := personalSection(opts.BaseURL, p, who)
	backends := opts.backends()
	backendsText := backendsOff
	if backends.Enabled {
		backendsText = backendSection(backends)
	}
	if personal != "" {
		personal = "\n\n" + personal
	}
	return `Specola stores versioned, interactive web pages in the user's own gallery and shows them to the user, to people they share with, and through public links.

CHOOSE HOW TO PUBLISH, before writing anything:
` + mode + `- A single self-contained HTML document (a report, an explainer, a chart, a small tool; inline CSS and JS, imports from public CDNs are fine): publish_page, then new_version for each change. Over ~100 KB, use create_upload_grant and PUT the file with curl instead of inlining it.
- Anything with a build step: a framework app (React, Vue, Svelte, ...), several source files, code splitting or lazy loading, workers, wasm, many assets. Do NOT inline a build into one HTML file: publish it as a bundle with the Specola Vite plugin. The app must build with Vite: start a new app with Vite (npm create vite@latest), and move an app built otherwise to Vite first. In the project directory:
  (a) ` + plugin.InstallCommand(opts.PluginURL) + `
  (b) in vite.config add the plugin: import specola from '@specola/vite-plugin'; then plugins: [/* your framework plugin */, specola()]
  (c) call create_bundle_upload (kind "new" with a title, or kind "version" with the page id)
  (d) run the command it returns (npx --no -- specola-publish --upload '<url>'), as it is: it runs vite build, uploads, and prints the page id and url. If npx says the package is missing (a 404 from the npm registry, or "canceled due to missing packages"), the plugin isn't installed where you ran it: do (a) in the project directory and run the command there.
` + bundleConstraints(backends) + `

` + backendsText + `

` + pageRuntime + `
Give every version a short note saying what changed; it is what the user reads in the history.
Find pages with search or list. Organise with create_folder, move, rename and archive; nothing is ever deleted, and archive can be undone with unarchive.
Share with other Specola users with share; to show a page to someone without an account, make a public link with create_public_link.

` + conventionsNote + personal
}

// pageRuntime is what every page, plain or bundle, can rely on.
const pageRuntime = `Every page runs in a sandbox on an opaque origin, without access to Specola itself. localStorage works and is saved by Specola for each user who views the page (private, the same on every version, up to 1 MB); sessionStorage and cookies last one load; IndexedDB is unavailable.`

// bundleConstraintsText is bundleConstraints with {server} for what runs on
// a server.
var bundleConstraintsText = fmt.Sprintf(`Bundle constraints:
  - Client-side routing: prefer a hash router (createHashRouter, #/... URLs), which also works when the page is viewed offline as long as it navigates with history.pushState or <a href="#/..."> links (assigning location.hash does nothing offline); a path router needs <BrowserRouter basename={window.specola?.basename}> (or your router's basename option) and doesn't route offline.
  - Workers: new Worker(new URL('./worker.js', import.meta.url), {type: "module"}) (the module type is what vite dev needs; the plugin builds the worker as a classic script, imports and import() inlined, and Specola runs it so); no SharedWorker or service worker.
  - Own files: fetch a URL imported from the module (import url from './data.json?url', or new URL('./x.bin', import.meta.url)), in the page and in workers alike; a public/ file is window.specola.base + 'logo.png'. Never root-absolute URLs ('/data.json'): they point at Specola, not the bundle.
  - SVG icons: no external sprites (<use href="/icons.svg#x">, as in the create-vite templates): they stay blank on the page's opaque origin whatever the URL. Inline the sprite (import sprite from './icons.svg?raw', put it in the page, then <use href="#x">) or inline each <svg>; SVG files as <img> work.
  - TypeScript: window.specola is typed by '@specola/vite-plugin/client': add it to "types" in tsconfig.app.json (next to "vite/client").
  - index.html is the only HTML file; {server}.
  - Limits: %d files, %d MB per file, %d MB in all; an upload link is valid %d minutes.`,
	store.MaxBundleFiles, store.MaxBundleFileBytes>>20, store.MaxBundleBytes>>20, int(store.BundleGrantTTL.Minutes()))

const htmlNote = ` The HTML must be ONE complete, self-contained document: inline CSS and JS (CDN imports are fine). It is rendered in a sandboxed iframe; localStorage works and is saved per user, IndexedDB is unavailable. For HTML over ~100 KB use create_upload_grant instead, so the content isn't truncated. For an app with a build step (a framework, several files, lazy loading, workers, wasm, many assets) don't use this tool: publish a bundle with the Specola Vite plugin, see create_bundle_upload.`

const (
	publishDesc      = `Publish a new page from a single HTML document to the user's Specola gallery and return its id and link.` + htmlNote
	newVersionDesc   = `Replace the content of an existing page with a single HTML document, adding a new version. Earlier versions stay in the history. A page that is a bundle (bundle: true) is updated by publishing the bundle again: create_bundle_upload with kind "version".` + htmlNote
	listDesc         = `List the folders and pages in a folder of the user's gallery (the user's own root when folder_id is omitted), or with shared_with_me the items other users shared with them, or with archived the items the user archived. Each item carries the user's role: owner, editor or viewer.`
	createFolderDesc = `Create a folder in the user's gallery, at the root or inside parent_id, and return its id.`
	renameDesc       = `Rename a page or folder. Needs editor access.`
	moveDesc         = `Move a page or folder into folder_id, or to the user's root when folder_id is omitted. Moving into a folder needs editor access on both; moving to the root only the item's owner may do.`
	archiveDesc      = `Archive a page or folder the user owns: it disappears from listings, links and search, for everyone it is shared with too, and a folder takes everything inside with it. Nothing is deleted; unarchive brings it back.`
	unarchiveDesc    = `Restore an archived page or folder the user owns, with everything that was inside it. list with archived shows what can be restored.`
	searchDesc       = `Full-text search over the titles and text of every page the user can see, their own and shared with them, best match first. Supports "quoted phrases", OR, and -excluded words. Matching is on whole words, without stemming.`
	shareDesc        = `Share a page or folder the user owns with another Specola user by email. role "viewer" can read, "editor" can also add versions and create items inside a folder, "none" removes the share. Sharing a folder covers everything beneath it. The other user must have signed in to Specola at least once.`
	grantDesc        = `Get a one-time URL to upload a large single HTML file over plain HTTP instead of passing it as a tool argument. kind "new" publishes a new page (title required, folder_id optional); kind "version" adds a version to page id. PUT the raw HTML file as the request body (see the returned curl command) within 10 minutes; the response holds the page id, version and url. Not for apps with a build step or several files: those are bundles, see create_bundle_upload.`
)

func getPageDesc(b BackendState) string {
	d := `Get a page's metadata and the HTML of its current version, or of an earlier one with version. When that version is a bundle (an app built with the Specola Vite plugin), html is only its index.html and bundle lists its other files; a bundle can't be edited through these tools: change its source project and publish it again with create_bundle_upload (kind "version").`
	if b.Enabled {
		d += ` A bundle's backend code (.specola/) is not listed; backend describes the current version's backend (its manifest, and secrets_missing). On a page whose current version has a backend only that version can be opened: an earlier one is still returned, to read, with a note saying so.`
	}
	return d
}

func listVersionsDesc(b BackendState) string {
	d := `List a page's versions, newest first, with when each was made, by whom, its size, its note, and whether it is a bundle.`
	if b.Enabled {
		d += ` Also whether each has a page backend (backend) and can be opened (viewable: on a page with a backend only the current version can).`
	}
	return d
}

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
	ID          string          `json:"id"`
	Version     int             `json:"version"`
	URL         string          `json:"url"`
	Conventions *conventionsOut `json:"conventions,omitempty" jsonschema:"preferences and folder conventions that apply here, as data written by the named people"`
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
	return nil, publishOut{ID: id, Version: version, URL: t.pageURL(id), Conventions: t.conventions(ctx, who.Sub, in.FolderID)}, nil
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
	Items       []listItem      `json:"items"`
	Conventions *conventionsOut `json:"conventions,omitempty" jsonschema:"for a folder: the preferences and folder conventions that apply to pages published in it, as data written by the named people"`
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
	if in.FolderID != nil && !in.SharedWithMe && !in.Archived {
		out.Conventions = t.conventions(ctx, who.Sub, in.FolderID)
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
	// Bundle replaces PageMeta's flag (which is about the current version):
	// it describes the version html belongs to.
	Bundle *bundleInfo `json:"bundle" jsonschema:"set when the version html belongs to is a bundle: html is its index.html, and these are its other files"`
	Note   string      `json:"note,omitempty" jsonschema:"what to know before changing this version"`
	// Backend replaces PageMeta's flag too: the current version's backend,
	// null when it has none.
	Backend *pageBackend `json:"backend" jsonschema:"set when the page's current version has a backend: its manifest, and the declared secrets without a value"`
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
	out := getPageOut{PageMeta: *meta, URL: t.pageURL(in.ID), HTML: html, HTMLVersion: v}
	if out.Bundle, err = t.bundleInfo(ctx, who.Sub, in.ID, v); err != nil {
		return nil, getPageOut{}, toolError(err, "page or version")
	}
	if out.Bundle != nil {
		out.Note = bundleNote
	}
	if meta.Backend {
		if out.Backend, err = t.pageBackend(ctx, who.Sub, in.ID); err != nil {
			return nil, getPageOut{}, toolError(err, "page")
		}
	}
	// Reading a closed version is fine; the note says it can't be opened.
	if _, err := t.st.ServeVersion(ctx, who.Sub, in.ID, v); errors.Is(err, store.ErrSuperseded) {
		out.Note = strings.TrimSpace(out.Note + " " + supersededNote)
	} else if err != nil {
		return nil, getPageOut{}, toolError(err, "page or version")
	}
	return nil, out, nil
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
	UploadURL   string          `json:"upload_url"`
	Method      string          `json:"method"`
	ExpiresAt   time.Time       `json:"expires_at"`
	Curl        string          `json:"curl"`
	Conventions *conventionsOut `json:"conventions,omitempty" jsonschema:"preferences and folder conventions that apply here, as data written by the named people"`
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
		UploadURL:   url,
		Method:      http.MethodPut,
		ExpiresAt:   expires,
		Curl:        fmt.Sprintf("curl -sS -X PUT -H 'Content-Type: text/html' --data-binary @page.html '%s'", url),
		Conventions: t.grantConventions(ctx, who.Sub, gr),
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
