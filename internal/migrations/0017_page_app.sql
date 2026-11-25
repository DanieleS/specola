-- Page apps' settings (docs/page-apps.md, "Author settings"): how a page
-- looks installed as an app, set by its editors. One row per page, not per
-- version: an installed app doesn't change name each time a version is
-- published. NULL (or no row) means the default, worked out from the page
-- (internal/pageapp). An uploaded icon is a bundle_blob, by sha256; the
-- blob sweep keeps the ones a row names.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE page_app (
  asset_id         uuid        PRIMARY KEY REFERENCES asset (id) ON DELETE CASCADE,
  name             text        CHECK (char_length(name) BETWEEN 1 AND 60),
  short_name       text        CHECK (char_length(short_name) BETWEEN 1 AND 12),
  display          text        CHECK (display IN ('standalone', 'fullscreen', 'minimal-ui')),
  orientation      text        CHECK (orientation IN ('portrait', 'landscape')),
  theme_color      text        CHECK (theme_color ~ '^#[0-9a-f]{6}$'),
  background_color text        CHECK (background_color ~ '^#[0-9a-f]{6}$'),
  icon_sha256      text        REFERENCES bundle_blob (sha256),
  icon_size        int         CHECK (icon_size >= 512),
  icon_maskable    boolean     NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by_sub   text        NOT NULL,
  CHECK ((icon_sha256 IS NULL) = (icon_size IS NULL))
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX page_app_icon_idx ON page_app (icon_sha256) WHERE icon_sha256 IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS page_app;
-- +goose StatementEnd
