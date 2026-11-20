package mcpserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/plugin"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// SPA bundles (docs/spa-bundles.md): apps built with the Specola Vite plugin
// on the agent's machine and uploaded by its CLI through a bundle upload link.

func bundleUploadDesc(pluginURL string) string {
	return `Get a one-time link to publish an app with a build step as a bundle: a framework app (React, Vue, Svelte, ...), several files, code splitting or lazy loading, workers, wasm, many assets. A single self-contained HTML document goes through publish_page instead.
kind "new" publishes a new page (title required, folder_id optional); kind "version" adds a version to page id. The app must build with Vite. Steps, in the app's project directory:
(a) once: ` + plugin.InstallCommand(pluginURL) + `
(b) once: add specola() to the plugins in vite.config (import specola from '@specola/vite-plugin')
(c) call this tool
(d) run the returned command within ` + bundleTTLText + `: it runs vite build and uploads only the files the server lacks, then prints {"id","version","url"}. Use --no-build if the app is already built into dist/, --dir for another output directory.
` + bundleConstraints + `
` + pageRuntime
}

var bundleTTLText = fmt.Sprintf("%d minutes", int(store.BundleGrantTTL.Minutes()))

// bundleNote tells an agent reading a bundle's HTML how to change it.
const bundleNote = `This version is a bundle: an app built with the Specola Vite plugin. html is only its index.html (bundle file references start with __SPECOLA_BASE__/), and bundle.files are its other files, served under bundle.base. Don't edit it through publish_page or new_version: change the app in its source project and publish it again with create_bundle_upload (kind "version") and the command that returns.`

type bundleUploadIn struct {
	Kind     string  `json:"kind" jsonschema:"new (publish a new page) or version (add a version to page id)"`
	Title    string  `json:"title,omitempty" jsonschema:"title of the new page; required for kind new"`
	FolderID *string `json:"folder_id,omitempty" jsonschema:"folder for the new page; the root when omitted"`
	ID       string  `json:"id,omitempty" jsonschema:"page to add a version to; required for kind version"`
	Note     string  `json:"note,omitempty" jsonschema:"optional, one line on what this version is or what changed; shown in the page's history"`
}

type bundleUploadOut struct {
	UploadURL     string    `json:"upload_url"`
	ExpiresAt     time.Time `json:"expires_at"`
	Command       string    `json:"command" jsonschema:"run this in the app's project directory: it builds the app and uploads it"`
	PluginInstall string    `json:"plugin_install" jsonschema:"installs the Specola Vite plugin into the project, if it isn't already"`
}

func (t *tools) createBundleUpload(ctx context.Context, req *mcp.CallToolRequest, in bundleUploadIn) (*mcp.CallToolResult, bundleUploadOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, bundleUploadOut{}, err
	}
	gr := store.GrantRequest{Sub: who.Sub, Note: in.Note, Bundle: true}
	var what string
	switch in.Kind {
	case "new":
		if strings.TrimSpace(in.Title) == "" {
			return nil, bundleUploadOut{}, errors.New("title is required for kind new")
		}
		gr.Kind, gr.Name, gr.FolderID, what = store.GrantUploadNew, strings.TrimSpace(in.Title), in.FolderID, "folder"
	case "version":
		if in.ID == "" {
			return nil, bundleUploadOut{}, errors.New("id is required for kind version")
		}
		gr.Kind, gr.AssetID, what = store.GrantUploadVersion, in.ID, "page"
	default:
		return nil, bundleUploadOut{}, errors.New(`kind must be "new" or "version"`)
	}
	token, expires, err := t.st.MintGrant(ctx, gr, store.BundleGrantTTL)
	if err != nil {
		return nil, bundleUploadOut{}, toolError(err, what)
	}
	url := t.opts.BaseURL + "/upload/bundle/" + token
	return nil, bundleUploadOut{
		UploadURL:     url,
		ExpiresAt:     expires,
		Command:       plugin.PublishCommand(url),
		PluginInstall: plugin.InstallCommand(t.opts.PluginURL),
	}, nil
}

// bundleInfo describes a bundle version's files; nil for a plain version.
type bundleInfo struct {
	Base  string       `json:"base" jsonschema:"URL the files are served under, ending in /"`
	Files []bundleFile `json:"files" jsonschema:"every file but index.html, by path"`
}

type bundleFile struct {
	Path        string `json:"path"`
	Size        int64  `json:"size"`
	ContentType string `json:"content_type"`
}

func (t *tools) bundleInfo(ctx context.Context, sub, id string, version int) (*bundleInfo, error) {
	key, files, err := t.st.VersionFiles(ctx, sub, id, version)
	if err != nil || key == "" {
		return nil, err
	}
	b := &bundleInfo{Base: t.opts.BundleBase(key), Files: make([]bundleFile, 0, len(files))}
	for _, f := range files {
		b.Files = append(b.Files, bundleFile{Path: f.Path, Size: f.Size, ContentType: f.ContentType})
	}
	return b, nil
}
