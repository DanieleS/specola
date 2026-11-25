package mcpserver

import "strings"

// Page backends (docs/page-backends.md): server code shipped in a bundle and
// run by the instance's backend runner, when it has one. Agents are told
// plainly either way: an instance without backends must not get apps
// designed around them, so its instructions say so in one line and nothing
// else about them.

// BackendState is whether page backends are enabled on the instance, whether
// the runner answers right now, and, when they can't be used, why.
type BackendState struct {
	Enabled   bool   `json:"enabled"`
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

// backends is the instance's current backend state.
func (o Options) backends() BackendState {
	if o.Backends == nil {
		return BackendState{}
	}
	return o.Backends()
}

// backendsOff is the whole of what an agent is told about backends on an
// instance without them (docs/page-backends.md, "Enabled or not").
const backendsOff = "Page backends are not enabled on this instance: bundles are static, `server/` code and `specola.fetch` are unavailable. Do not design apps that need them."

// backendSection tells an agent how to give a bundle a backend, as far as
// this version of Specola supports it.
func backendSection(st BackendState) string {
	state := ""
	if !st.Available {
		state = "\n  - Right now the backend runner is not answering: pages can be published, but their backends answer 503 until it is back."
	}
	return `PAGE BACKENDS: a bundle can carry server code, run by this instance for the page: for data shared between the people who open it, or logic that must not run in the browser. A single HTML page can't have one; a bundle can.
  - In vite.config: specola({ server: 'server/index.ts' }); the manifest goes in the plugin's backend option (or specola.backend.json next to vite.config). The plugin builds the server into the bundle's .specola/ directory; publish with create_bundle_upload as usual.
  - server/index.ts: export default { async fetch(request, ctx) { ... return Response.json(data) } }, with standard Request and Response (a router such as Hono works); request.url is https://page.invalid/<path>?<query>. Responses may stream.
  - ctx: user {sub, email, name}; role "owner" | "editor" | "viewer"; page {id, version, title}; db (node:sqlite DatabaseSync shared by everyone on the page); userDb (node:sqlite, private to ctx.user); files (put(key, body, {contentType}), get(key), delete(key), list(prefix)); log (like console, read in the page's backend log); waitUntil(promise).
  - In the app: await specola.fetch('/api/items', { method: 'POST', body }) — the fetch signature, relative paths starting with / only (they reach the backend; anything else is a TypeError). It rejects with a BackendUnavailable error (reason "disabled", "unavailable", "superseded" or "offline") when the backend can't be reached; specola.backend is {enabled, available}. Add '@specola/vite-plugin/server' types for ctx.
  - Whoever can open the page can call any route with any body: check ctx.user and ctx.role in every handler. An editor of the page can change its code, and so read all its data.
  - Data belongs to the page, not the version: it survives new versions, so migrate the schema in code (PRAGMA user_version). Only the current version of a page with a backend can be opened; older versions stay in the history (viewable: false) and can be restored.
  - .specola/backend.json: {"version": 1, "entry": "server/index.mjs", "public": [...], "egress": [...], "secrets": [...], "cron": [...], "topics": {"public": [...]}}; only version is required. Not available yet: secrets, egress rules, routes for public links, cron jobs and push (ctx.publish does nothing): don't build on them.
  - Limits: request body 25 MiB, 8 requests at once per user and page, 5 minutes per request (30 s to the first byte).` + state
}

// bundleConstraints are what an app must respect to run as a bundle, one
// line each; what runs on a server depends on whether backends are enabled.
func bundleConstraints(st BackendState) string {
	server := "nothing runs on a server (no SSR or API routes)"
	if st.Enabled {
		server = "server code goes in a page backend (see PAGE BACKENDS), never SSR"
	}
	return strings.Replace(bundleConstraintsText, "{server}", server, 1)
}
