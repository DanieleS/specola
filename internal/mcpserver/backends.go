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

// backendSection tells an agent how to give a bundle a backend: the whole
// feature as built (docs/page-backends.md), kept short.
func backendSection(st BackendState) string {
	state := ""
	if !st.Available {
		state = "\n  - Right now the backend runner is not answering: pages can be published, but their backends answer 503 until it is back."
	}
	return `PAGE BACKENDS: a bundle can carry server code, run by this instance for the page: for data shared between the people who open it, logic or API keys that must not reach the browser, scheduled jobs, live updates. A single HTML page can't have one; a bundle can.
  - In vite.config: specola({ server: 'server/index.ts', backend: { ...backend.json fields } }) (or specola.backend.json next to vite.config). The plugin builds the server into the bundle's .specola/; publish with create_bundle_upload as usual. vite dev runs the backend too (secrets from .env).
  - server/index.ts: export default { async fetch(request, ctx) { ... return Response.json(data) }, async scheduled(event, ctx) { ... } }, with standard Request and Response (a router such as Hono works); request.url is https://page.invalid/<path>?<query>; responses may stream. event is {name, scheduledTime}.
  - ctx: user {sub, email, name} (null for public-link visitors and cron); role "owner" | "editor" | "viewer" | "public" | "cron"; link (the public link used, or null); page {id, version, title}; db (node:sqlite DatabaseSync shared by everyone on the page); userDb (node:sqlite, private to ctx.user; null without one); files (put(key, body, {contentType}), get(key), delete(key), list(prefix)); secrets {NAME: value}; publish(topic, data, {to: sub}?) (JSON up to 7 KiB, 50/s per page); log (like console, read in the page's backend log); waitUntil(promise). Types: '@specola/vite-plugin/server'.
  - In the app: await specola.fetch('/api/items', { method: 'POST', body }) — the fetch signature, relative paths starting with / only (anything else is a TypeError). It rejects with a BackendUnavailable error (reason "disabled", "unavailable", "superseded" or "offline") when the backend can't be reached; specola.backend is {enabled, available}. const unsubscribe = specola.subscribe(topic, data => ...) gets what the backend publishes on topic, while the page is open (best effort, no replay: reload state with specola.fetch after reconnecting).
  - .specola/backend.json: {"version": 1, "entry": "server/index.mjs", "public": ["GET /api/stats", "POST /api/votes", "GET /api/public/*"], "egress": ["api.example.com", "*.example.org"], "secrets": ["API_KEY"], "cron": [{"name": "nightly", "schedule": "0 3 * * *"}], "topics": {"public": ["scores"]}}; only version is required.
  - secrets: names the code reads from ctx.secrets. Their values are set by the page's owners in the page's Backend panel in Specola, never through MCP or in code; list_secrets says which are missing.
  - egress: the only hosts the backend's fetch may reach (https, or http on port 80); anything else, and private addresses, are refused.
  - cron: up to 10 jobs, 5-field schedules in UTC, at most once a minute, calling scheduled(event, ctx); missed runs are not caught up.
  - public: the routes a public link's anonymous visitor may call (ctx.role "public"); every other route answers them 403. topics.public: the topics they may subscribe to. A public link on a backend page always shows its current version.
  - Whoever can open the page can call any route with any body: check ctx.user and ctx.role in every handler. An editor of the page can change its code, and so read all its data and secrets.
  - Data belongs to the page, not the version: it survives new versions, so migrate the schema in code (PRAGMA user_version). Only the current version of a page with a backend runs and can be opened; older versions stay in the history (viewable: false) and can be restored.
  - To test what you published, as the user: call_backend (a request, as specola.fetch would send it), backend_logs (console output and errors), backend_query (read-only SQL on the shared database), list_secrets.
  - Limits: request body 25 MiB, 8 requests at once per user and page, 5 minutes per request (30 s to the first byte), 1 GiB of data per page.` + state
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
