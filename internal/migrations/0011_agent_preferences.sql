-- Agent preferences and folder conventions (docs/agent-preferences.md): what
-- agents publishing through the MCP should use by default. A user's
-- preferences are private to them; a folder's conventions are written by its
-- owner, read by anyone who can see the folder, and inherited by every
-- sub-folder (the nearest folder that has conventions wins). A style
-- reference is a page; it only counts for a user who can see it, which is
-- checked when it is read, not here.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE user_preferences (
  sub                text PRIMARY KEY,
  -- auto: the agent picks a single file or a bundle; bundle: always a bundle.
  mode               text NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'bundle')),
  text               text NOT NULL DEFAULT '' CHECK (char_length(text) <= 4000),
  style_ref_asset_id uuid REFERENCES asset(id) ON DELETE SET NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TABLE folder_conventions (
  folder_id          uuid PRIMARY KEY REFERENCES folder(id) ON DELETE CASCADE,
  text               text NOT NULL DEFAULT '' CHECK (char_length(text) <= 4000),
  style_ref_asset_id uuid REFERENCES asset(id) ON DELETE SET NULL,
  -- Who wrote them: agents are told, so the text reads as someone's words.
  updated_by_sub     text NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS folder_conventions;
DROP TABLE IF EXISTS user_preferences;
-- +goose StatementEnd
