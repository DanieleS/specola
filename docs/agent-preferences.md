# Agent preferences and folder conventions — design

Status: implemented (migration `0011_agent_preferences.sql`,
`internal/store/preferences.go`, `internal/mcpserver/preferences.go`,
`web/src/lib/Settings.svelte`, `web/src/lib/ConventionsDialog.svelte`).
Mockup: https://claude.ai/artifact/JyrQM98WsyNK5zd7ikRUom

Agents publishing through the MCP decide stack and style from scratch every
time, so pages drift apart. Users and folder owners can state what agents
should use by default.

## What can be set

- **User preferences** (per user, private):
  - publishing mode: `auto` (the agent picks a single file or a bundle) or
    `bundle` (always a Vite project published with the plugin);
  - free-form Markdown for stack and style (framework, charts, language,
    palette, what to avoid), up to 4000 characters;
  - optional style reference: a Specola page the user can see, from which
    agents take colours, typography and components.
- **Folder conventions** (per folder, set by its owner only):
  - free-form Markdown, up to 4000 characters, plus an optional style
    reference page;
  - inherited by every sub-folder, like shares; the nearest folder that has
    conventions wins.

Precedence: the user's explicit request to the agent > folder conventions >
user preferences.

## Where they are edited (UI)

- **User preferences**: a "Preferences" link in the header, next to Logout
  (`web/src/App.svelte`), opening `#/settings` with the form of the mockup's
  first board.
- **Folder conventions** (owners only, as for sharing):
  - a "Conventions…" item in a folder card's ⋯ menu, next to Rename, Move…
    and Share… (`web/src/lib/Gallery.svelte`);
  - a "Conventions" button in the bar of an open folder the user owns, next to
    Share and + Page;
  - optionally a small marker on the card of a folder that has conventions.
  Both open the dialog of the mockup's second board.

## How agents get them (MCP)

- At MCP `initialize` the request already carries the user's token, so the
  server appends the user's preferences to its `instructions`.
- When an agent publishes into a folder, the conventions in force there
  arrive at decision time: a `conventions` object in the results of
  `create_bundle_upload`, `publish_page`, `create_upload_grant` and `list` on
  that folder: `{folder: {path, text}, user: {text}, style_reference: {id, name, version}, precedence: "request > folder > user"}`.
  The agent-facing view is not shown in the UI.

## Safety

Folder conventions are text written by someone else that lands in the
context of the agent of whoever publishes there (prompt injection). So:

- only the folder's owner writes them; length is capped;
- they are presented to agents as preferences to respect, clearly delimited
  as data written by a named user, never as instructions to execute;
- a style reference only counts if the publishing user can see that page.

## API (sketch)

- `GET/PUT /api/me/preferences` → `{mode, text, styleRefId}`.
- `GET/PUT/DELETE /api/folders/{id}/conventions` (`PUT` owner only) →
  `{text, styleRefId, updatedBy, updatedAt}`; `GET` also returns the
  effective (inherited) conventions and which folder they come from.
- Storage: `user_preferences(sub PK, mode, text, style_ref_asset_id, updated_at)`
  and `folder_conventions(folder_id PK, text, style_ref_asset_id, updated_by_sub, updated_at)`.

## Implementation notes

Where the sketch above was open, the implementation decided:

- Migration `0011` (`0010` was taken by bundle blob storage). Both tables cap
  `text` at 4000 characters with a CHECK; style references point at `asset`
  with `ON DELETE SET NULL`. Empty conventions (no text, no reference) are
  deleted rather than stored.
- Per-user instructions: `mcpserver.Handler` serves one stateless
  `mcp.Server`, so every request, `initialize` included, carries the bearer
  token. A receiving middleware rewrites the `instructions` of the
  `initialize` (and `server/discover`, marked `cacheScope: private`) result
  for that user; no extra tool is needed. The instructions always explain
  the `conventions` object, precedence and that it is data; with
  preferences they end with a section naming the user, the mode, the style
  reference and the Markdown between `<<<BEGIN/END USER PREFERENCES>>>`
  markers (markers inside the text are removed). Mode `bundle` adds a line
  at the top of "CHOOSE HOW TO PUBLISH".
- The `conventions` object is returned whenever something applies (folder
  conventions in force, or non-default user preferences), also at the
  user's root for the publishing tools; `list` returns it only for a
  folder. It adds `about` (how to take it), `folder.id`, `folder.inherited`,
  `folder.written_by`, `folder.updated_at`, `user.mode`, and
  `style_reference.url`/`from` (`folder` or `user`: the folder's reference
  wins if the publisher can see it). For a new version, the page's folder
  counts, also when only the page is shared with the publisher. A failure to
  read conventions never fails the tool call.
- `folder.path` runs from the top of the tree to the folder the conventions
  are set on; folders the reader can't see, that one included (conventions
  inherited by a sub-folder shared on its own), are shown as `…`. The id of
  a style reference the reader can't see is told only to the folder's
  owners (so they can save the conventions with it unchanged).
- `GET /api/folders/{id}/conventions` answers `{own, effective, canEdit}`;
  `PUT` and `DELETE` answer the same. Saving with a style reference left
  unchanged skips the visibility check, so text can still be saved after the
  page became invisible (it doesn't count until visible again).
- Listings flag folders with conventions (`conventions: true`) for the card
  marker. On a phone the header's Preferences link is an icon.
