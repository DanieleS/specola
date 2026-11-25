# Page apps — design and contract

Status: design. Nothing here is implemented yet.

A **page app** is one page installed on its own as a Progressive Web App: its
own icon on the home screen or in the dock, its own window, its own name, and
none of Specola's chrome around it. Any page can be installed, by anyone who
can see it:

- **signed-in**, from `/app/{id}/`, by anyone with at least `VIEWER` on it;
- **public**, from `/app/s/{token}/`, by anyone holding a public link, with no
  account (a dashboard shared with a client, a tool handed to a team).

The page's author (its editors) decides how the app looks: name, colors,
display mode and icon. Without settings, everything has a sensible default.

This document is the contract between the server, the SPA and the service
worker. Keep it in sync with the code.

## Goals and non-goals

- One installable app per page, distinct from Specola and from every other
  page app, on the same origin as Specola.
- Same security model as the viewer: the page runs in a sandboxed iframe on an
  opaque origin, served from the view origin when there is one.
- Same features as the viewer: page storage, bundles, offline.
- Public links installable with no account, and an app stops working as soon
  as its link is revoked or expires.
- Author-controlled appearance, settable from the SPA and the MCP tools.
- Non-goals (v1): push notifications, share targets, file handlers, shortcuts,
  pinning a version for a signed-in app (public links can already pin one),
  storage that survives reloads in public apps (see "Open questions").

## Browser facts this relies on

Verified in Chromium 158 (headless, `Page.getAppManifest` over CDP):

| Fact | Result |
| --- | --- |
| Document served with CSP `sandbox` (no `allow-same-origin`) and a `<link rel="manifest">` | manifest **not fetched** |
| `navigator.serviceWorker.register` in that document | `SecurityError` |
| Manifest behind a session cookie, `<link rel="manifest">` without `crossorigin` | fetched **without cookies** (401, empty manifest) |
| Same, with `crossorigin="use-credentials"` | fetched with cookies, parsed |
| Manifests with `id`/`scope` `/app/x/` and `/app/y/` on an origin whose own manifest has scope `/` | each parsed with its own `id` and scope |

Hence: a public link (`/s/{token}`) can't itself be the app, so a
non-sandboxed shell on the app origin frames it, as the viewer already does.
The signed-in manifest is linked with `crossorigin="use-credentials"`.

Known, to be checked by hand on real devices (headless can't install):

- Chrome/Edge desktop and Android install apps with nested scopes separately,
  and a navigation goes to the app with the most specific scope.
- iOS/iPadOS read the title and `apple-touch-icon` from the HTML at "Add to
  Home Screen", not from the manifest, and give **each home screen app its own
  cookies and storage**, apart from Safari and from each other.

## URLs

All on the **app origin** (`SPECOLA_BASE_URL`), never on the view origin: the
app needs the service worker and, when signed in, the session.

| URL | Auth | What |
| --- | --- | --- |
| `GET /app/{id}/` | session | The app shell for page `{id}`. No session: `302` to `/auth/login?next=/app/{id}/`. |
| `GET /app/{id}/manifest.webmanifest` | session | Its manifest. `404` without access, as everywhere. |
| `GET /app/s/{token}/` | the token | The app shell for a public link. |
| `GET /app/s/{token}/manifest.webmanifest` | the token | Its manifest. |
| `GET /app/s/{token}/info` | the token | JSON the public shell needs (below). |
| `GET /app-icons/{sha256}.png` | none | An uploaded icon. The hash is the capability, as a bundle key is. |
| `GET /app-icons/g/{rrggbb}/{letter}/{size}.png` | none | A generated icon (below). Reveals nothing that isn't in its URL. |
| `GET/PUT/DELETE /api/pages/{id}/app` | session, editor to change | The page's app settings. |
| `PUT /api/pages/{id}/app/icon` | session, editor | Upload the icon (raw PNG body). |

Any other path under `/app/` answers `404`, not the SPA shell. `{id}` is a
UUID, so `/app/s/...` never collides with it.

Shell responses (`/app/...` HTML, manifests, `info`) are `Cache-Control:
no-cache`. Public ones add `Referrer-Policy: no-referrer` and `X-Robots-Tag:
noindex, nofollow`, as `/s/{token}` does. Icons are `immutable` for a year.

### The shell

`/app/{id}/` and `/app/s/{token}/` serve the SPA's `index.html` with its
`<head>` rewritten:

```html
<link rel="manifest" href="/app/{id}/manifest.webmanifest" crossorigin="use-credentials">
<title>{name}</title>
<meta name="theme-color" content="{theme_color}">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="{short_name}">
<link rel="apple-touch-icon" href="{icon 512}">
```

(The public shell links its manifest without `crossorigin`: the token is the
credential, so cookies aren't needed.) Specola's own manifest link and title
are removed. Nothing else is injected: the SPA reads the page id or token from
`location.pathname`, so a cached shell for one app also works offline for
another.

### The manifest

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
    { "src": "{icon}", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "{icon}", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

The public form uses `/app/s/{token}/` for `id`, `start_url` and `scope`. `id`
never changes for a page, so renaming it or changing its settings updates the
installed app rather than making a new one. A public link is a different app
from the page's signed-in app, and from every other link to the same page.

The `maskable` entry is listed only when the icon is maskable (generated icons
are; an uploaded icon is when its author says so).

### Defaults

Every field the author leaves unset is derived:

| Field | Default |
| --- | --- |
| `name` | The page's title. |
| `short_name` | `name`, cut at 12 characters on a word boundary. |
| `display` | `standalone` |
| `orientation` | left out (`any`) |
| `theme_color` | `<meta name="theme-color">` of the current version (the version the link shows, for public apps), else Specola's `#0b0d12`. |
| `background_color` | `theme_color` |
| icon | Generated: the first letter of `name` in white on a color picked from the page id, so two apps on one device are told apart. |

### Generated icons

`/app-icons/g/{rrggbb}/{letter}/{size}.png`: `{letter}` is one Unicode letter or
digit (URL-escaped), `{size}` is `192` or `512`, the color is one of a fixed
palette of 12 (other values `404`). Drawn in Go with the standard library and a
small embedded font, square, with the letter inside the maskable safe zone (the
central 80%). Memoised in memory: at most 12 × 2 per letter in use.

## Data

Migration `0012_page_app.sql`:

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

- One row per page, not per version: an installed app doesn't change name each
  time a version is published. `NULL` means "use the default".
- The icon is stored in `bundle_blob`, deduplicated like bundle files. The
  sweep of unused blobs counts `page_app.icon_sha256` as a use.
- Archiving a page leaves its row; deleting it removes it.

## API

`GET /api/pages/{id}/app` (viewer): the settings as stored, the values in
effect (defaults filled in) and the app's URL:

```json
{
  "settings": { "name": null, "themeColor": "#1e40af", "display": null, "iconMaskable": false, "icon": null },
  "effective": { "name": "Budget 2027", "shortName": "Budget 2027", "display": "standalone",
                 "themeColor": "#1e40af", "backgroundColor": "#1e40af",
                 "icon": "/app-icons/g/1e40af/B/512.png", "iconMaskable": true },
  "url": "/app/{id}/"
}
```

`PUT /api/pages/{id}/app` (editor): any of `name`, `shortName`, `display`,
`orientation`, `themeColor`, `backgroundColor`, `iconMaskable`; `null` resets a
field to its default. Invalid values answer `400`.

`PUT /api/pages/{id}/app/icon` (editor): a PNG body, at most 1 MiB, square, at
least 512×512 (larger is fine: the browser scales). Anything else answers
`400` naming the problem. Its stored copy is the uploaded bytes, unchanged.
`DELETE /api/pages/{id}/app/icon` goes back to the generated icon.
`DELETE /api/pages/{id}/app` resets everything.

`GET /app/s/{token}/info` (public): what the public shell needs to show and
keep the page:

```json
{ "title": "Budget 2027", "version": 7, "bundle": false, "url": "https://view.example.com/s/{token}" }
```

`404` when the link doesn't exist or has been revoked, `410` when it has
expired, exactly as `/s/{token}`. Neither `info` nor the manifest counts as a
view; loading the page in the frame does.

Page metadata (`GET /api/pages/{id}`) gains `appUrl`.

### Changes to public links

So the public shell can frame and keep them, `/s/{token}` responses (on
whichever origin serves them) change:

- `frame-ancestors` goes from `'none'` to the app origin (`'self'` without a
  view origin). Only Specola's own shell can frame a public page.
- `Access-Control-Allow-Origin: {app origin}`, as `/view/{id}` already sends on
  the view origin, so the shell can fetch the HTML for offline.
- A link's URL is still only given when it is created. The dialog then shows
  both the page URL (`/s/{token}`) and the app URL (`/app/s/{token}/`), and
  `create_public_link` returns both (`url`, `appUrl`).

## Login

`/auth/login` takes `next`: a path on the app origin (starts with `/`, not
`//`, no scheme), kept in the state cookie. The callback redirects there
instead of `/`. Anything else is ignored. This also lets a signed-out visit to
any deep link come back to it.

## SPA

- `main.ts` picks the root component from the path: `/app/s/{token}/` →
  `PublicAppShell`, `/app/{id}/` → `AppShell`, anything else → `App`.
- The iframe, view token, page storage and offline fallback move out of
  `PageViewer` into a `PageFrame` component. `PageViewer` keeps the toolbar,
  history, sharing and the rest, and uses `PageFrame`. Both shells are a
  full-viewport `PageFrame` and an install banner, nothing else.
- **Install banner**: on `beforeinstallprompt`, an "Install" button that calls
  `prompt()`. On iOS/iPadOS Safari, a short "Share → Add to Home Screen" hint
  instead. Hidden when `display-mode` is `standalone`, `fullscreen` or
  `minimal-ui`, and once dismissed (remembered in `localStorage`).
- **Viewer**: "Install as app" in the ⋯ menu opens `/app/{id}/` in a new tab
  (`beforeinstallprompt` only fires on the page that links the manifest).
- **App settings** dialog for editors (⋯ → "App"): fields above, icon upload
  with a preview of the icon both plain and masked, and a preview of the
  theme color. Viewers see "Install as app" only.
- Errors in a shell are full-screen and plain: "You don't have access to this
  page" (with a sign-in button when signed out), "This link has been revoked",
  "This link has expired".

## Offline and the service worker

`/sw.js` (scope `/`) stays the only service worker. It serves page apps too:

- Navigations under `/app/` are network-first. Each response is kept in a
  `specola-apps` cache under its URL. Offline, the cached copy of that URL is
  served, else the cached Specola shell (the SPA reads the id or token from the
  path, so it still works, only without the app's head). `/app-icons/` is
  cache-first.
- **Signed-in apps** use the offline store that exists today
  (`offline.svelte.ts`). When a shell runs as an installed app (`display-mode`
  not `browser`), or on `appinstalled`, it **pins** its page. On each start
  online it brings that page up to its current version, as Specola does for
  every pinned page. A `404` drops it and shows the access error. Logout and
  signing in as someone else wipe it, as today.
- **Public apps** keep their page in a separate store, keyed by the sha256 of
  the token, holding only that page (the version `info` reports, and its
  bundle files). It isn't tied to a user, so logout and `claim(sub)` leave it
  alone. A `404` or `410` from `info` deletes it and shows the error. Offline,
  the page is shown from a `blob:` URL in the same sandboxed iframe, as in the
  viewer.
- When a newer version arrives while an app is open, a small "Updated to
  version N — reload" toast; the app never reloads on its own.

## MCP

- `set_page_app` (editor): the fields of `PUT /api/pages/{id}/app`, and `icon`
  as base64 PNG (at most 1 MiB decoded, same checks). Returns `effective` and
  `url`.
- `get_page` and the publishing tools return `appUrl`.
- `create_public_link` returns `appUrl` next to `url`.

## Security notes

- The page still runs on an opaque origin in a sandboxed iframe: installing it
  gives its scripts nothing they didn't have in the viewer. The shell's HTML
  comes from Specola, never from the page.
- Signed-in manifests and shells need the session and answer `404` without
  access, so a page id reveals nothing. Public ones need the token, which is
  already the credential for the page; the manifest exposes only the title and
  theme color, which the page itself shows.
- The token of an installed public app is kept on the device (manifest `id`,
  `start_url`, the shell cache), as a bookmark would be. Revoking the link
  ends the app at its next online start.
- Uploaded icons are served by content hash only, as `image/png` with
  `nosniff`, after decoding them as PNG server-side.
- `next` on login is restricted to local paths: no open redirect.

## Tests

- Go: shell head rewriting (manifest link and `crossorigin`, title,
  `apple-touch-icon`); manifests' fields and defaults (title, theme color
  from the version, generated icon); `404` without access, signed-out redirect
  with `next`; public `404`/`410`; `info` and the manifest don't count views;
  `/s/{token}` `frame-ancestors` and CORS on both origin setups; settings
  validation and editor-only changes; icon checks; the blob sweep keeps icons;
  `next` rejects `//host`, `https://host`, `\host`; MCP `set_page_app`.
- e2e (Playwright, `e2e/page-apps.mjs`): `Page.getAppManifest` parses each
  app's manifest with its `id` and scope, signed-in and public; the public
  shell shows a page from the view origin; an installed-mode signed-in app and
  a public app reload offline and show their page; a revoked link shows the
  error and drops the kept copy.
- By hand, on real devices: install from Chrome desktop and Android next to
  Specola itself, from iOS Safari (separate sign-in per app), rename and
  restyle and see the installed app update.

## Order of work

1. `next` on login; routes, shells and manifests with defaults; generated
   icons; `PageFrame`; both shells with the install banner; service worker and
   offline for both; public link `frame-ancestors`/CORS and `appUrl`.
2. `page_app` with the API, icon upload and the blob sweep; the "App" dialog;
   `set_page_app` and `appUrl` in MCP.
3. README ("Page apps", the iOS caveat) and this document's status.

## Open questions

- **Storage in public apps.** Public pages keep `localStorage` in memory only,
  so an installed public tool forgets everything when closed. Keeping it on
  the device (IndexedDB on the app origin, handed to the page SDK as signed-in
  pages' data is) would make public apps far more useful; it needs a decision
  on whether that's wanted, and is left out of v1.
- **Opting out.** Every page and every public link is installable. A per-page
  switch could be added later if an author needs to prevent it, though anyone
  who can see a page can already bookmark it.
