-- SPA bundles (docs/spa-bundles.md): a version can be a multi-file build of a
-- single-page app. Its index.html stays in asset_version.content, like a plain
-- page; the other files are rows of asset_version_file pointing at
-- content-addressed blobs, deduplicated across every version and page.
-- bundle_key marks a version as a bundle and is the capability in its file
-- URLs. A bundle upload grant keeps the manifest it accepted until commit.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE bundle_blob (
  sha256     text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL,
  content    bytea NOT NULL,
  -- When the blob was last uploaded: the sweep spares recent blobs.
  created_at timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE asset_version ADD COLUMN bundle_key text UNIQUE;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TABLE asset_version_file (
  asset_version_id uuid   NOT NULL REFERENCES asset_version(id) ON DELETE CASCADE,
  path             text   NOT NULL,
  sha256           text   NOT NULL REFERENCES bundle_blob(sha256),
  content_type     text   NOT NULL,
  size_bytes       bigint NOT NULL,
  PRIMARY KEY (asset_version_id, path)
);
-- +goose StatementEnd
-- +goose StatementBegin
-- For the blob sweep: is this blob still referenced?
CREATE INDEX asset_version_file_sha256_idx ON asset_version_file (sha256);
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE asset_grant ADD COLUMN bundle boolean NOT NULL DEFAULT false;
ALTER TABLE asset_grant ADD COLUMN manifest jsonb;
-- The blobs uploaded through the grant: the commit may use them, as well as
-- those of versions the user can see, but no other existing blob.
ALTER TABLE asset_grant ADD COLUMN uploaded text[] NOT NULL DEFAULT '{}';
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE asset_grant DROP COLUMN IF EXISTS uploaded;
ALTER TABLE asset_grant DROP COLUMN IF EXISTS manifest;
ALTER TABLE asset_grant DROP COLUMN IF EXISTS bundle;
DROP TABLE IF EXISTS asset_version_file;
ALTER TABLE asset_version DROP COLUMN IF EXISTS bundle_key;
DROP TABLE IF EXISTS bundle_blob;
-- +goose StatementEnd
