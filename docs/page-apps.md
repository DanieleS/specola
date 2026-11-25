# Page apps — design and contract

Status: implemented. Checked in Chromium by `e2e/page-apps.mjs` (signed-in
and public apps, offline, visitors, the App dialog) and `e2e/backends.mjs`
(a public visitor's own `userDb`); installing on real devices is checked by
hand (see "Browser facts").

A **page app** is one page installed on its own as a Progressive Web App: its
own icon on the home screen or in the dock, its own window and name, and none
of Specola's chrome around it. Any page can be installed, by anyone who can
see it:

- **signed in**, from `/app/{id}/` on the app origin, by anyone with at least
  `VIEWER` on it;
- **public**, from the public link itself, `/s/{token}`, by anyone holding
  it, with no account. The shareable URL doesn't change: every public link is
  installable.

The page's editors decide how the app looks: name, colors, display mode and
icon. Unset, everything has a default.

Public visitors get an **anonymous identity**, one per link and browser, so
a public page keeps its `localStorage` and, with a backend, its `userDb`,
across loads, as a signed-in user's.

This document is the contract between the server, the runner, the SPA, the
public shell and the service workers. Keep it in sync with the code.

## Goals and non-goals

- One installable app per page (signed in) and per public link, distinct
  from Specola and from each other.
- Same security model as the viewer: the page runs on an opaque origin in a
  sandboxed iframe, served from the view origin when there is one.
- **One shell per kind**: the viewer's frame code (`PageFrame`) for
  signed-in apps, the existing public shell (`publicshell.html`) for public
  links.
- **One data path**: visitors' `localStorage` lives in `page_data`, their
  backend data in the runner's per-user databases, with the same code and
  limits as signed-in users'.
- Non-goals: push notifications, share targets, shortcuts, pinning a version
  in a signed-in app, a visitor's "download my data", moving a visitor's data
  into an account, a public SPA bundle offline.

## Browser facts this relies on

Verified in Chromium 158 (headless, `Page.getAppManifest` over CDP):

| Fact | Result |
| --- | --- |
| Document served with CSP `sandbox` (no `allow-same-origin`) and a `<link rel="manifest">` | manifest **not fetched** |
| `navigator.serviceWorker.register` in that document | `SecurityError` |
| Manifest behind a session cookie, `<link rel="manifest">` without `crossorigin` | fetched **without cookies** (401, empty manifest) |
| Same, with `crossorigin="use-credentials"` | fetched with cookies, parsed |
| Manifests with `id`/`scope` `/app/x/` and `/app/y/` on an origin whose own manifest has scope `/` | each parsed with its own `id` and scope |
| `Emulation.setEmulatedMedia` with `display-mode` | not supported: the e2e marks the shell installed with `navigator.standalone` instead |

Hence: the page itself can never be the app, a non-sandboxed shell around it
is (the viewer, or the public shell), and the signed-in manifest is linked
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

Any other path under `/app/` answers `404`. All are `Cache-Control:
no-cache`.

`/app/{id}/` is the SPA's `index.html` with its head rewritten (`apps.go`,
`appShell`): Specola's manifest link, title, theme color, icons and
`apple-mobile-web-app-title` replaced by

```html
<link rel="manifest" href="/app/{id}/manifest.webmanifest" crossorigin="use-credentials">
<title>{name}</title>
<meta name="theme-color" content="{theme_color}">
<meta name="apple-mobile-web-app-title" content="{short_name}">
<link rel="icon" type="image/png" href="{icon 192}">
<link rel="apple-touch-icon" href="{icon 512}">
```

Nothing else is injected: `main.ts` reads the id from `location.pathname`
and mounts `AppShell` instead of `App`, so a cached shell works offline for
any app.

`/auth/login` takes `next`: a local path (starts with `/`, not `//`, no
backslash or line break, no scheme or host; `auth.SafeNext`), kept for the
flow in a cookie (`specola_login_next`, path `/auth/`, 10 minutes); the
callback redirects there instead of `/`. A signed-out request for any
non-API path is sent to the login with `next` set to itself.

## Public apps

The public shell (`publicshell.html`) is the shell of **every** public link,
with or without a backend:

- `/s/{token}` and `/s/{token}/*` serve the shell (or the link's error:
  `404`, `410`). It frames `/s/{token}/~page/…`, which serves the page with
  basename `/s/{token}/~page`, CSP `sandbox` and `frame-ancestors 'self'`.
  Each load of `~page` counts as a view; the shell and its manifest don't.
- Other names under `/s/{token}/~` are Specola's and answer `404`.
- Its head is rewritten as a signed-in shell's, with the manifest at
  `/s/{token}/~app.webmanifest` (no `crossorigin`: the token is the
  credential).
- Its CSP: `default-src 'none'; script-src 'self' 'unsafe-inline';
  frame-src 'self' blob:; connect-src 'self'; style-src 'unsafe-inline';
  manifest-src 'self'; img-src 'self'; worker-src 'self'`, with
  `X-Frame-Options: DENY`, `Cache-Control: no-store`, `Referrer-Policy:
  no-referrer`, `X-Robots-Tag: noindex`.
- Its boot data: `{token, version, backend, pageSrc, hasBackend, bundle,
  name, offline}`. A page without a backend gets `backend: {enabled: false,
  available: false}`.
- It registers `/public-sw.js` (scope `/s/`), offers to install (below),
  hands the page its visitor's data, and relays its backend calls.

Served on the same origin as `/s/` always was (the view origin when there is
one), so the shell and `/p/` need no CORS.

## Manifest

```json
{
  "id": "/app/{id}/",
  "start_url": "/app/{id}/",
  "scope": "/app/{id}/",
  "name": "{name}",
  "short_name": "{short_name}",
  "display": "{display}",
  "orientation": "{orientation, when set}",
  "theme_color": "{theme_color}",
  "background_color": "{background_color}",
  "icons": [
    { "src": "{icon 192}", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "{icon 512}", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "{icon 512}", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

An uploaded icon is listed once at its own size (`"1024x1024"`), and as
`maskable` too when its author says so; the generated icon is always
maskable. The public form has `id` and `start_url` `/s/{token}/` and scope
`/s/{token}`, so the link as shared (no trailing slash) is in scope. `id`
never changes, so renaming or restyling updates the installed app rather than
making a new one. Each public link is its own app.

### Defaults

`internal/pageapp` works out how an app looks (`LookOf`), from the author's
settings and the version shown:

| Field | Default |
| --- | --- |
| `name` | The page's name. |
| `short_name` | `name`, cut at 12 characters on a word boundary. |
| `display` | `standalone` |
| `orientation` | left out (`any`) |
| `theme_color` | `<meta name="theme-color">` of the version shown (`#rgb` or `#rrggbb`), else `#0b0d12`. |
| `background_color` | `theme_color` |
| icon | Generated: the first letter or digit of the name, in white, on one of 12 colors picked from the page id. |

### Icons

Served on both origins, no auth, `immutable`, `nosniff`:

- `/app-icons/g/{rrggbb}/{letter}/{size}.png`: generated, drawn with Go's
  bold font, the letter inside the maskable safe zone; `{size}` 192 or 512,
  the color one of the palette, the letter upper case and in the font (else
  `404`). Memoised.
- `/app-icons/{sha256}.png`: an uploaded icon, only while some page's app
  uses it (a bundle's files aren't served here).

## Author settings

Migration `0017_page_app.sql`: `page_app(asset_id, name, short_name,
display, orientation, theme_color, background_color, icon_sha256, icon_size,
icon_maskable, updated_at, updated_by_sub)`. One row per page, not per
version; `NULL` means the default. An uploaded icon is a `bundle_blob`; the
blob sweep keeps the ones a row names.

| API | Who | What |
| --- | --- | --- |
| `GET /api/pages/{id}/app` | viewer | `{settings, effective, url, canEdit}`: the settings as set (`null` for a default; `icon` the uploaded icon's URL), the look in effect, `/app/{id}/`. |
| `PUT /api/pages/{id}/app` | editor | Any of `name` (≤ 60), `shortName` (≤ 12), `display` (`standalone`, `fullscreen`, `minimal-ui`), `orientation` (`portrait`, `landscape`), `themeColor`, `backgroundColor` (`#rrggbb`, lower case), each a string or `null` for the default, and `iconMaskable`. Fields left out stay. `400` naming the problem. |
| `DELETE /api/pages/{id}/app` | editor | Every default again. |
| `PUT /api/pages/{id}/app/icon` | editor | A PNG body: square, at least 512 × 512, at most 1 MiB, decoded server-side. |
| `DELETE /api/pages/{id}/app/icon` | editor | Back to the generated icon. |

Each answers as `GET`. `GET /api/pages/{id}` has `appUrl`.

## Anonymous visitors

### Identity

- A **visitor** is one browser on one link. The shell asks for one
  (`POST /p/{token}/visitor` → `201 {"secret"}`) before its first write or
  backend call, keeps the secret in its own origin's `localStorage`
  (`specola:public-visitor:{token}`) and sends it in `X-Specola-Visitor`.
  Only its sha256 (hex) is stored. Viewing a page makes none.
- **No cookies.** The shell's calls are `credentials: "omit"`: without a
  view origin, public links share Specola's origin and its session cookie,
  which never reaches them.
- `POST /p/{token}/visitor` takes only a browser saying it is on this origin
  (`Sec-Fetch-Site: same-origin`); every `/p/{token}/data` request is refused
  (`403 not-shell`) when `Sec-Fetch-Site` or `Origin` say otherwise, as a
  sandboxed page's (`null`) do.
- A secret the link doesn't know (forgotten, or from before the link was
  remade) counts as none: reads give `{}` with `X-Specola-Visitor: none`,
  writes `403 no-visitor`, and the shell asks for a new one.

Migration `0016_public_visitors.sql`:

- `public_visitor(link_id, visitor_hash, asset_id, created_at,
  last_seen_at)`, deleted with its link.
- `page_data` gains `link_id` and `visitor_hash`, with a check that they are
  both null for a user (whose `user_sub` can't start with `anon:`) or both
  set for a visitor, whose `user_sub` is `anon:{visitor_hash}`, and a foreign
  key to its visitor (and through it to the link's page), so its rows go
  with it. One row shape, one code path: `store.PageData` and
  `UpdatePageData` share their core (`readPageData`, `writePageData`: lock,
  quota, upsert) with `VisitorData` and `UpdateVisitorData`.
- Anything that reads `page_data` per user (export, statistics, cleanup on
  unshare) must filter `link_id IS NULL`.
- `visitor_cleanup(asset_id, visitor_hash)`, filled by a trigger when a
  visitor is deleted: the runner's database for it is still to delete.

### `localStorage`

`GET/PATCH/DELETE /p/{token}/data`, with `X-Specola-Visitor`: the bodies and
limits of `/api/pages/{id}/data` (1000 keys, 1 MB). The shell uses the
viewer's protocol: the data loaded before the page and handed over in the
frame's name, writes one at a time, each answered once saved. Unsaved writes
wait in the shell's `localStorage` (`specola:public-outbox:{token}`), with
the data last saved (`specola:public-data:{token}`), so they survive a
reload offline and are sent when back online. `window.specola.persistent` is
`true`.

### Backend

A public call carrying a visitor the link knows has `visitor: {"id"}` in
the runner's head (the hash, never the secret; `X-Specola-Visitor` isn't
among the headers listed for the backend). In the handler:

- `ctx.user` stays `null` and `ctx.role` `"public"`;
- `ctx.visitor` is `{ id }`, or `null`;
- `ctx.userDb` is the visitor's own database, kept as a user's under the
  subject `anon:{id}`, at most 16 MiB (SQLite `max_page_count`), within the
  page's disk quota; `null` without a visitor.

"Reset every user's data" covers visitors.

### Limits and cleanup

| Limit | Default |
| --- | --- |
| Visitors per link | 1000 (`SPECOLA_PUBLIC_VISITORS_PER_LINK`) |
| New visitors | 10 a minute per link and client IP, 120 per link |
| `localStorage` per visitor | as a user's: 1000 keys, 1 MB |
| `userDb` per visitor | 16 MiB |

Past a limit, `POST /p/{token}/visitor` answers `429 visitor-limit`: the
page's storage stays in memory and its backend calls have no visitor.

Every 10 minutes (`Server.SweepVisitors`), visitors unused for 90 days are
deleted with their page data; then the runner is asked to delete the
databases of visitors gone (`DELETE /pages/{id}/my-data` for `anon:{hash}`),
for pages whose backend has run, when it can be reached. Revoking a link
deletes its visitors at once. The links dialog shows, per link, how many
visitors keep data and how much, never the data.

## Offline

- **App origin**: `/sw.js` treats navigations to `/app/{id}/` network
  first, keeping each in a `specola-apps` cache under its path; offline it
  serves that copy, else Specola's shell (which still shows the app, without
  its head). `/app-icons/` is cache first. A signed-in app pins its page
  (`offline.keep(meta, v, true)`) when it runs installed (`display-mode` not
  `browser`, `navigator.standalone`, or after `appinstalled`), and keeps it
  as a recent page otherwise; each start online brings it up to date, and a
  `404` drops it and says so. Logout wipes it, `specola-apps` included.
- **Public links**: `/public-sw.js` (scope `/s/`) treats navigations to a
  link's shell network first, keeping one copy per link under `/s/{token}/`;
  offline it serves that copy with `"offline":true` in its boot data. A link
  answering `404` or `410` has its copies deleted. It never handles `~page`,
  `/p/`, `/view/` or `/b/` requests. Installed, the shell keeps the page
  itself (`GET ~page` with `X-Specola-Keep: 1`, not counted as a view) under
  `/s/{token}/~kept`, and offline shows it from a `blob:` URL in the same
  sandbox. An SPA bundle isn't kept: offline, the shell says it needs a
  connection.
- **Pages with a backend**: calls need the network. Offline,
  `specola.backend.available` is `false` and `specola.fetch` rejects with
  `BackendUnavailable` (`reason: "offline"`); **the page decides what to
  show**. Nothing is queued. The plugin's README tells authors.
- A newer version while an app is open: the reload notice both shells have;
  an app never reloads by itself.

## SPA

- `main.ts`: `/app/{id}/` → `AppShell`, anything else → `App`.
  `listenForInstall()` catches `beforeinstallprompt` before anything mounts.
- `startSession()` (`session.ts`) starts the session the same way in Specola
  and in a page app: who is signed in, backends, offline data bound to the
  user, unsaved page data writes folded back in.
- `PageFrame`: the sandboxed frame, view token, port (storage,
  `specola.fetch`, pushes) and offline fallback, shared by `PageViewer` and
  `AppShell`.
- `InstallBanner` (signed-in apps) and the public shell's own: the
  browser's prompt where it has one, "Share → Add to Home Screen" on iOS;
  never in an installed app, nor once dismissed.
- Viewer: "Install as app ↗" (opens `/app/{id}/`), and "App…" for editors
  (`AppSettings`): the settings, with the icon plain and masked.
- Links dialog: says links are installable, and how many visitors keep data.

## MCP

- `set_page_app` (editor): `name`, `short_name`, `display`, `orientation`,
  `theme_color`, `background_color`, `icon_maskable` (each optional, `""`
  resets), `icon_png_base64` or `generated_icon`. Returns the look in effect
  and `app_url`.
- `publish_page` and `get_page` return `app_url`; `create_public_link` says
  the link is installable and that each visitor has storage of its own.

## Security notes

- The page still runs on an opaque origin; installing it gives its scripts
  nothing new. The shells are Specola's documents, never the page's.
- A signed-in shell and manifest need the session and answer `404` without
  access. A public one needs the token, already the page's credential; the
  manifest shows the name and colors, which the page itself shows.
- A visitor's secret is only ever in the shell's storage and in its own
  requests' header: a page can't read it (opaque origin) nor use it, and
  requests from elsewhere are refused. It authorises nothing but that
  visitor's own data on that link.
- The visitor caps and creation limits bound what an anonymous caller can
  store; the page's disk quota still bounds the runner.
- An installed public app keeps its token on the device, as a bookmark does.
  Revoking the link ends it, and deletes its visitors' data.
- Uploaded icons are decoded as PNG on upload and served by sha256 as
  `image/png`, `nosniff`, `sandbox`, only while an app uses them.
- `next` on login is a local path only.

## Tests

- Go: `apps_test.go` (shells, manifests, defaults, icons, the settings API,
  `set_page_app`), `visitors_test.go` (visitors, their data, origin checks,
  caps, revocation and idle cleanup, the runner head and deletion),
  `publiclinks_test.go` and `publicshell_test.go` (the shell for every link),
  `internal/pageapp` (defaults, validation, icon checks), `internal/auth`
  (`SafeNext`), config (`SPECOLA_PUBLIC_VISITORS_PER_LINK`).
- Runner: a visitor's `ctx.visitor` and capped `userDb`.
- e2e: `page-apps.mjs`, `backends.mjs`, and `bundles.mjs` (a bundle through a
  public link's `~page`).
