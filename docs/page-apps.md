# Page apps — design and contract

Status: step 1 of "Order of work" is implemented (signed-in apps: login
with `next`, `/app/{id}/`, manifests with defaults, generated icons,
`PageFrame` and `AppShell`, the app-origin service worker), checked in
Chromium by `e2e/page-apps.mjs`. The rest is design.

A **page app** is one page installed on its own as a Progressive Web App: its
own icon on the home screen or in the dock, its own window and name, and none
of Specola's chrome around it. Any page can be installed, by anyone who can
see it:

- **signed in**, from `/app/{id}/` on the app origin, by anyone with at least
  `VIEWER` on it;
- **public**, from the public link itself, `/s/{token}`, by anyone holding
  it, with no account. The shareable URL doesn't change: every public link is
  installable.

The page's author (its editors) decides how the app looks: name, colors,
display mode and icon. Unset, everything has a default.

Public visitors get an **anonymous identity**, one per link and device, so a
public page keeps its `localStorage` and, with a backend, its `userDb`,
across loads, like a signed-in user's.

This document is the contract between the server, the runner, the SPA, the
public shell and the service workers. Keep it in sync with the code.

## Goals and non-goals

- One installable app per page (signed in) and per public link, distinct from
  Specola and from each other.
- Same security model as today: the page runs on an opaque origin in a
  sandboxed iframe, served from the view origin when there is one.
- **One shell per kind, no duplicates**: the viewer's port code (`pagedata.ts`)
  for signed-in apps, the existing public shell (`publicshell.html`) for public
  links. Public apps don't get a second shell.
- **One data path, no duplicates**: anonymous visitors' `localStorage` lives in
  `page_data` and their backend data in the runner's per-user databases, with
  the same code and limits as signed-in users'.
- Non-goals (v1): push notifications, share targets, shortcuts, pinning a
  version in a signed-in app, a visitor's "download my data", moving a
  visitor's data into an account.

## Browser facts this relies on

Verified in Chromium 158 (headless, `Page.getAppManifest` over CDP):

| Fact | Result |
| --- | --- |
| Document served with CSP `sandbox` (no `allow-same-origin`) and a `<link rel="manifest">` | manifest **not fetched** |
| `navigator.serviceWorker.register` in that document | `SecurityError` |
| Manifest behind a session cookie, `<link rel="manifest">` without `crossorigin` | fetched **without cookies** (401, empty manifest) |
| Same, with `crossorigin="use-credentials"` | fetched with cookies, parsed |
| Manifests with `id`/`scope` `/app/x/` and `/app/y/` on an origin whose own manifest has scope `/` | each parsed with its own `id` and scope |

Hence: the page itself can never be the app, a non-sandboxed shell around it
is (the viewer, or the public shell); and the signed-in manifest is linked
with `crossorigin="use-credentials"`.

To check by hand on real devices (headless can't install):

- Chrome/Edge desktop and Android install nested-scope apps separately, and a
  navigation goes to the app with the most specific scope.
- iOS/iPadOS read the title and `apple-touch-icon` from the HTML at "Add to
  Home Screen", and give **each home screen app its own cookies and
  storage**: a separate sign-in per signed-in app, a separate visitor per
  public app.

## Signed-in apps

On the **app origin** only (session and service worker live there).

| URL | Auth | What |
| --- | --- | --- |
| `GET /app/{id}` | session | `301` to `/app/{id}/`. |
| `GET /app/{id}/` | session | The shell. No session: `302` to `/auth/login?next=/app/{id}/`. Without access: `404` with Specola's plain shell, so the SPA says so. |
| `GET /app/{id}/manifest.webmanifest` | session | Its manifest; `404` without access. |

Any other path under `/app/` answers `404`. Both are `Cache-Control:
no-cache`.

`/app/{id}/` is the SPA's `index.html` with its head rewritten: Specola's
manifest link and title replaced by

```html
<link rel="manifest" href="/app/{id}/manifest.webmanifest" crossorigin="use-credentials">
<title>{name}</title>
<meta name="theme-color" content="{theme_color}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="{short_name}">
<link rel="apple-touch-icon" href="{icon}">
```

Nothing else is injected: the SPA reads the id from `location.pathname`, so a
cached shell works offline for any app.

`/auth/login` takes `next`: a local path (starts with `/`, not `//`, no
backslash or line break, no scheme or host), kept for the flow in a cookie
(`specola_login_next`, path `/auth/`, 10 minutes); the callback redirects
there instead of `/`, anything else is ignored. A signed-out request for any
non-API path is sent to the login with `next` set to itself.

## Public apps

The public shell (`publicshell.html`, docs/page-backends.md, "Public links")
becomes the shell of **every** public link, with or without a backend:

- `/s/{token}` and `/s/{token}/*` serve the shell; it frames
  `/s/{token}/~page/…`, which serves the page as `/s/{token}` does today
  (basename `/s/{token}/~page`). `~page` stops answering 404 for pages
  without a backend. A page without a backend gets the port too (storage),
  with `backend.available = false`.
- Its head gains the same tags as a signed-in shell, with the manifest at
  `/s/{token}/manifest.webmanifest` (no `crossorigin`: the token is the
  credential), and its `<title>` becomes the app's name.
- Its CSP gains `manifest-src 'self'; img-src 'self'; worker-src 'self'`.
- It registers the public service worker (below).
- It hands the page its data (see "Anonymous visitors") instead of answering
  "a public link keeps localStorage in memory only".

Served on the same origin as today (the view origin when there is one), so
`/s/`, `/p/` and the shell stay together and need no CORS. Responses keep
`no-store`, `no-referrer` and `noindex`.

| URL | What |
| --- | --- |
| `GET /s/{token}/manifest.webmanifest` | The manifest; `404`/`410` as the link. Doesn't count as a view. |
| `GET /public-sw.js` | The public service worker, scope `/s/`. `no-cache`. |

## Manifest

```json
{
  "id": "/app/{id}/",
  "start_url": "/app/{id}/",
  "scope": "/app/{id}/",
  "name": "{name}",
  "short_name": "{short_name}",
  "display": "{display}",
  "orientation": "{orientation}",
  "theme_color": "{theme_color}",
  "background_color": "{background_color}",
  "icons": [
    { "src": "{icon 192}", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "{icon 512}", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "{icon 512}", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

Public: `id` and `start_url` are `/s/{token}/`, `scope` is `/s/{token}`.
`id` never changes, so renaming or restyling updates the installed app rather
than making a new one. Each public link is its own app. The `maskable` entry
is listed only when the icon is maskable.

### Defaults

| Field | Default |
| --- | --- |
| `name` | The page's name. |
| `short_name` | `name`, cut at 12 characters on a word boundary. |
| `display` | `standalone` |
| `orientation` | left out (`any`) |
| `theme_color` | `<meta name="theme-color">` of the version shown, else `#0b0d12`. |
| `background_color` | `theme_color` |
| icon | Generated: the first letter of `name` in white on a color picked from the page id (maskable). |

### Icons

Served on both origins, no auth, `immutable`:

- `/app-icons/{sha256}.png`: an uploaded icon; the hash is the capability.
- `/app-icons/g/{rrggbb}/{letter}/{size}.png`: generated, `{size}` 192 or
  512, the color one of a fixed palette of 12 (others `404`). Drawn in Go with
  the standard library and an embedded font, letter inside the maskable safe
  zone, memoised.

## Author settings

Migration `0016_page_app.sql`:

```sql
CREATE TABLE page_app (
  asset_id         uuid PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  name             text CHECK (char_length(name) <= 60),
  short_name       text CHECK (char_length(short_name) <= 12),
  display          text CHECK (display IN ('standalone', 'fullscreen', 'minimal-ui')),
  orientation      text CHECK (orientation IN ('portrait', 'landscape')),
  theme_color      text CHECK (theme_color ~ '^#[0-9a-f]{6}$'),
  background_color text CHECK (background_color ~ '^#[0-9a-f]{6}$'),
  icon_sha256      bytea REFERENCES bundle_blob(sha256),
  icon_maskable    boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_sub   text NOT NULL
);
```

Per page, not per version. `NULL` means the default. Icons live in
`bundle_blob`; the blob sweep counts `page_app.icon_sha256` as a use.

| API | Who | What |
| --- | --- | --- |
| `GET /api/pages/{id}/app` | viewer | `{settings, effective, url}` |
| `PUT /api/pages/{id}/app` | editor | Any of `name`, `shortName`, `display`, `orientation`, `themeColor`, `backgroundColor`, `iconMaskable`; `null` resets one. `400` when invalid. |
| `DELETE /api/pages/{id}/app` | editor | Reset everything. |
| `PUT /api/pages/{id}/app/icon` | editor | PNG body, ≤ 1 MiB, square, ≥ 512×512, decoded server-side. |
| `DELETE /api/pages/{id}/app/icon` | editor | Back to the generated icon. |

`GET /api/pages/{id}` gains `appUrl`.

## Anonymous visitors

### Identity

- A **visitor** is created on a public link's first write: the first
  `PATCH /p/{token}/data` or the first backend call
  (`/p/{token}/x/…`). Reading creates nothing, so plain views and crawlers
  leave no trace.
- Its secret is 32 random bytes in a cookie `specola_v`: `HttpOnly`,
  `Secure`, `SameSite=Strict`, `Path=/p/{token}/`, a year, renewed on use.
  Only its sha256 is stored. The cookie is per link: two links, two
  visitors, even on one device.
- Requests carrying it must come from the shell: `/p/` refuses an `Origin`
  other than its own (a sandboxed page's `null` included).

```sql
-- 0017_public_visitors.sql
CREATE TABLE public_visitor (
  link_id      uuid NOT NULL REFERENCES public_link(id) ON DELETE CASCADE,
  visitor_hash text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, visitor_hash)
);

ALTER TABLE page_data
  ADD COLUMN link_id uuid,
  ADD COLUMN visitor_hash text,
  ADD CONSTRAINT page_data_visitor_ck CHECK (
    (link_id IS NULL AND visitor_hash IS NULL AND user_sub NOT LIKE 'anon:%') OR
    (link_id IS NOT NULL AND visitor_hash IS NOT NULL AND user_sub = 'anon:' || visitor_hash)),
  ADD CONSTRAINT page_data_visitor_fk FOREIGN KEY (link_id, visitor_hash)
    REFERENCES public_visitor (link_id, visitor_hash) ON DELETE CASCADE;

CREATE INDEX page_data_link_idx ON page_data (link_id) WHERE link_id IS NOT NULL;
```

A visitor's subject is `anon:{visitor_hash}`: it can never collide with an
OIDC `sub`, and it is what the existing data code keys on. `page_data` keeps
one row shape and one code path; `link_id`/`visitor_hash` only tie the row to
its visitor so revocation and cleanup cascade. A row's `asset_id` is the
link's page.

Anything that reads `page_data` "per user" (export, cleanup on unshare,
statistics) must filter `link_id IS NULL`; a store test checks that visitors'
rows never appear in a signed-in user's reads.

### `localStorage`

`GET/PATCH/DELETE /p/{token}/data`: same bodies and answers as
`/api/pages/{id}/data`. `store.PageData`/`UpdatePageData` split into a shared
core on an authorised `(asset, sub)` (lock, quota, upsert, unchanged) and two
entries: today's, which checks access with `checkPage`, and the public one,
which checks the link as serving it does (exists, not expired, creator still
owner) and resolves the visitor.

The public shell uses the same protocol as the viewer: data loaded before
the page and passed in the frame's `name`, writes batched and retried,
unsaved writes kept in the shell's own `localStorage` (the shell is on a real
origin). `window.specola.persistent` is `true`.

### Backend

The runner head of a public call gains `visitor: {"id": "<visitor_hash>"}`
when the caller has one. In the handler:

- `ctx.user` stays `null` and `ctx.role` stays `"public"`: being anonymous
  doesn't change.
- `ctx.visitor` is `{ id }`, stable per link and device, or `null` (no
  visitor yet, or over the cap).
- `ctx.userDb` is the visitor's own database, kept as a user's is, under the
  subject `anon:{visitor_hash}`. `null` when `ctx.visitor` is.

So "Reset every user's data" covers visitors, and cleanup uses the runner's
existing "Delete my data" path for that subject.

docs/page-backends.md, "Handler contract" and "Public links", are updated to
match (`userDb` is no longer always `null` for `role: "public"`).

### Limits and cleanup

| Limit | Default |
| --- | --- |
| Visitors per link | 1000 (`SPECOLA_PUBLIC_VISITORS_PER_LINK`) |
| New visitors per link and client IP | 10 a minute |
| `localStorage` per visitor | as a user's: 1000 keys, 1 MB |
| `userDb` per visitor | 16 MiB (SQLite `max_page_count`), within the page's disk quota |

Past a cap, no visitor is created: storage works in memory and `ctx.visitor`
and `userDb` are `null`, as public links behave today; the shell shows
nothing, `specola.persistent` tells the page.

A visitor is deleted, with its `page_data` (cascade) and its `userDb`
(runner), when its link is revoked, and when unused for 90 days
(`last_seen_at`, swept with the bundle blobs). The links dialog shows, per
link, how many visitors keep data and how much; never the data.

## Offline

- **App origin**: `/sw.js` treats navigations under `/app/` network-first,
  keeping each in a `specola-apps` cache under its URL; offline it serves
  that copy, else the Specola shell. `/app-icons/` is cache-first. A
  signed-in app running installed (`display-mode` not `browser`, or on
  `appinstalled`) pins its page in the existing offline store and syncs it on
  each start online; a `404` drops it. Logout wipes it, as today.
- **View origin**: `/public-sw.js` (scope `/s/`) keeps the shell and the
  page (`~page` and, for bundles, its files) of each link it serves, network
  first; `404`/`410` deletes that link's copies. It never handles `/p/`,
  `/view/` or `/b/` requests from pages, and the pages, being opaque, are
  never its clients. Visitor data waits in the shell as described above.
- **Pages with a backend**: calls need the network. Offline,
  `specola.backend.available` is `false` and `specola.fetch` rejects with
  `BackendUnavailable` (`reason: "offline"`); **the page decides what to
  show**. Specola queues nothing. Page authors are told so in the plugin
  README and the MCP description.
- A newer version while an app is open uses the reload notice both shells
  already have; an app never reloads by itself.

## SPA

- `main.ts`: `/app/{id}/` → `AppShell`, anything else → `App`.
- The frame, view token, port (storage, `specola.fetch`, events, reload
  notice) and offline fallback move from `PageViewer` into `PageFrame`.
  `PageViewer` keeps its toolbar and panels around it; `AppShell` is a
  full-viewport `PageFrame` and the install banner.
- **Install banner** (both shells): `beforeinstallprompt` → "Install"; iOS
  Safari → "Share → Add to Home Screen"; hidden in standalone and once
  dismissed.
- Viewer header: "Install as app ↗" (opens `/app/{id}/` in a new tab), and
  "App…" for editors: the settings with an icon preview, plain and masked.
- `startSession()` (`session.ts`) starts the session the same way in
  Specola and in a page app: who is signed in, backends, offline data bound
  to the user, unsaved page data writes folded back in.
- Links dialog: "Install" hint next to each new URL, visitor counts per link.

## MCP

- `set_page_app` (editor): the settings, and `icon` as base64 PNG (same
  checks). Returns `effective` and `url`.
- `get_page` and the publishing tools return `appUrl`; `create_public_link`
  says the link is installable.
- The backend description mentions `ctx.visitor` and offline handling.

## Security notes

- Pages still run on an opaque origin; installing gives their scripts
  nothing new. Shells come from Specola, never from the page.
- Signed-in shells and manifests need the session and answer `404` without
  access. Public ones need the token, already the page's credential; the
  manifest shows only the name and theme color.
- A visitor cookie is `HttpOnly`, per link path, and only accepted from the
  shell's origin: a page (any page, on the shared view origin) can't use or
  read another visitor's identity. It authorises nothing but that visitor's
  own data on that link.
- Visitor caps and per-IP creation limits bound what an anonymous caller can
  store; the page's disk quota still bounds the runner.
- An installed public app keeps its token on the device, as a bookmark does.
  Revoking the link ends it, and deletes its visitors' data.
- Uploaded icons are served by hash, `image/png`, `nosniff`, after decoding.
- `next` on login is local paths only.

## Tests

- Go: signed-in shell head, manifest fields and defaults, `404` and the
  signed-out redirect; `next` rejects `//h`, `/\h`, `https://h`; public shell
  for a page without a backend (`~page`, port, storage), its CSP and
  manifest, `404`/`410`, no view counted; settings validation, editor-only,
  icon checks, blob sweep keeps icons; visitors: created on first write only,
  cookie attributes, `Origin` check, caps and rate limit, revoke and 90-day
  cleanup cascade, visitor rows never in a user's reads; the runner head
  carries `visitor`; MCP `set_page_app`.
- Runner: `ctx.visitor`, a visitor's `userDb`, its size cap, deletion.
- e2e (`e2e/page-apps.mjs`): each manifest parses with its `id` and scope;
  a public page keeps `localStorage` across reloads and a backend page its
  `userDb`, per visitor (two browser contexts); offline reload of a signed-in
  and a public app; revoking a link shows the error and drops kept copies.
- By hand: install on Chrome desktop and Android next to Specola, on iOS
  Safari; rename and restyle and see the installed app update.

## Order of work

1. `next` on login; `/app/{id}/`, manifests with defaults, generated icons;
   `PageFrame` and `AppShell`; app-origin service worker.
2. Public shell for every link: `~page`, manifest, install banner,
   `public-sw.js`.
3. Visitors: tables, `/p/{token}/data`, the shell's storage, `ctx.visitor`
   and `userDb` in the runner, limits and cleanup.
4. `page_app`: API, icon upload, "App…" dialog, MCP.
5. README ("Page apps", the iOS caveat, offline with a backend), the backend
   doc's public-link section, this document's status.
