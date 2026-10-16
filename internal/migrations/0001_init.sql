-- +goose Up
-- +goose StatementBegin
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- +goose StatementEnd

-- Sentinel used by the partial-unique indexes so that root-level items
-- (parent_id / folder_id IS NULL) still collide on duplicate slugs — a plain
-- unique index treats NULLs as distinct and would let two root "foo" exist.

-- +goose StatementBegin
CREATE TABLE folder (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id         uuid REFERENCES folder(id) ON DELETE RESTRICT,
  name              text NOT NULL,
  slug              text NOT NULL,
  created_by_email  text,
  updated_by_email  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  archived_at       timestamptz,
  archived_by_email text
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX folder_parent_slug_active_key
  ON folder (COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX folder_parent_idx ON folder (parent_id);
-- +goose StatementEnd

-- A page. `kind` is an enum from day one so LIVE/DESIGN variants can be added
-- later without a table rewrite; Phase 1 only ever stores DASHBOARD.
-- +goose StatementBegin
CREATE TYPE asset_kind AS ENUM ('DASHBOARD');
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TABLE asset (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id         uuid REFERENCES folder(id) ON DELETE RESTRICT,
  name              text NOT NULL,
  slug              text NOT NULL,
  kind              asset_kind NOT NULL DEFAULT 'DASHBOARD',
  -- Denormalised pointer to the latest version number, bumped in the same tx
  -- as every version insert so listings never need a MAX() subquery.
  current_version   int NOT NULL DEFAULT 0,
  created_by_email  text,
  updated_by_email  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  archived_at       timestamptz,
  archived_by_email text
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX asset_folder_slug_active_key
  ON asset (COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
  WHERE deleted_at IS NULL AND archived_at IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX asset_folder_idx ON asset (folder_id);
-- +goose StatementEnd

-- Immutable version history. The HTML lives inline in `content` (self-contained
-- pages are small); collaterals/source files are a Phase 2 side bundle.
-- +goose StatementBegin
CREATE TABLE asset_version (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id            uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  version             int  NOT NULL,
  content             text NOT NULL,
  content_hash        text NOT NULL,
  size_bytes          int  NOT NULL,
  original_filename   text,
  restored_from_version int,
  edited_by_email     text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, version)
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX asset_version_asset_idx ON asset_version (asset_id);
-- +goose StatementEnd

-- Sharing. One row grants ONE email ONE role on a folder XOR an asset. VIEWER
-- means "may see" (and locks an otherwise-open item); EDITOR means "may write".
-- A folder grant is inherited by everything beneath it.
-- +goose StatementBegin
CREATE TYPE acl_role AS ENUM ('VIEWER', 'EDITOR');
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TABLE acl_entry (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id        uuid REFERENCES folder(id) ON DELETE CASCADE,
  asset_id         uuid REFERENCES asset(id)  ON DELETE CASCADE,
  subject_email    text NOT NULL,
  role             acl_role NOT NULL DEFAULT 'VIEWER',
  created_by_email text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT acl_entry_folder_xor_asset CHECK ((folder_id IS NULL) <> (asset_id IS NULL))
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX acl_asset_subject_key  ON acl_entry (asset_id, subject_email)  WHERE asset_id IS NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX acl_folder_subject_key ON acl_entry (folder_id, subject_email) WHERE folder_id IS NOT NULL;
-- +goose StatementEnd

-- Short-lived, single-use capability to move bytes over plain HTTP, so an agent
-- harness can `curl` a large HTML body instead of pushing it through an MCP
-- tool-argument budget. The token itself is never stored, only its sha256.
-- +goose StatementBegin
CREATE TYPE asset_grant_kind AS ENUM ('UPLOAD_NEW', 'UPLOAD_VERSION', 'DOWNLOAD');
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TABLE asset_grant (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             asset_grant_kind NOT NULL,
  secret_hash      text NOT NULL UNIQUE,
  asset_id         uuid REFERENCES asset(id)  ON DELETE CASCADE,
  folder_id        uuid REFERENCES folder(id) ON DELETE CASCADE,
  name             text,
  created_by_email text NOT NULL,
  consumed_at      timestamptz,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX asset_grant_expires_idx ON asset_grant (expires_at);
-- +goose StatementEnd

-- Personal stars. No users table anywhere: the subject is always a JWT email.
-- +goose StatementBegin
CREATE TABLE favorite (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email text NOT NULL,
  folder_id  uuid REFERENCES folder(id) ON DELETE CASCADE,
  asset_id   uuid REFERENCES asset(id)  ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT favorite_folder_xor_asset CHECK ((folder_id IS NULL) <> (asset_id IS NULL))
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX favorite_user_folder_key ON favorite (user_email, folder_id) WHERE folder_id IS NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX favorite_user_asset_key  ON favorite (user_email, asset_id)  WHERE asset_id IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS favorite;
DROP TABLE IF EXISTS asset_grant;
DROP TABLE IF EXISTS acl_entry;
DROP TABLE IF EXISTS asset_version;
DROP TABLE IF EXISTS asset;
DROP TABLE IF EXISTS folder;
DROP TYPE IF EXISTS asset_grant_kind;
DROP TYPE IF EXISTS acl_role;
DROP TYPE IF EXISTS asset_kind;
-- +goose StatementEnd
