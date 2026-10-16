-- Identify users by their OIDC `sub` instead of email. Access tokens issued for
-- an API resource (the MCP endpoint) carry `sub` but not `email`, and an email
-- can change over time while `sub` is stable. Only test data exists so far, so
-- the email columns are renamed in place; their values are not converted.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE app_user (
  sub           text PRIMARY KEY,
  email         text,
  name          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementEnd
-- +goose StatementBegin
-- Emails are matched case-insensitively when sharing; several subs may carry
-- the same email (e.g. linked social logins), so this is not unique.
CREATE INDEX app_user_email_idx ON app_user (lower(email));
-- +goose StatementEnd

-- +goose StatementBegin
ALTER TABLE folder RENAME COLUMN created_by_email  TO created_by_sub;
ALTER TABLE folder RENAME COLUMN updated_by_email  TO updated_by_sub;
ALTER TABLE folder RENAME COLUMN archived_by_email TO archived_by_sub;

ALTER TABLE asset RENAME COLUMN created_by_email  TO created_by_sub;
ALTER TABLE asset RENAME COLUMN updated_by_email  TO updated_by_sub;
ALTER TABLE asset RENAME COLUMN archived_by_email TO archived_by_sub;

ALTER TABLE asset_version RENAME COLUMN edited_by_email TO edited_by_sub;

ALTER TABLE acl_entry RENAME COLUMN subject_email    TO subject_sub;
ALTER TABLE acl_entry RENAME COLUMN created_by_email TO created_by_sub;

ALTER TABLE asset_grant RENAME COLUMN created_by_email TO created_by_sub;

ALTER TABLE favorite RENAME COLUMN user_email TO user_sub;
-- +goose StatementEnd

-- Owner lookups back the per-author visibility filter on every listing.
-- +goose StatementBegin
CREATE INDEX folder_owner_idx ON folder (created_by_sub);
CREATE INDEX asset_owner_idx  ON asset (created_by_sub);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS asset_owner_idx;
DROP INDEX IF EXISTS folder_owner_idx;

ALTER TABLE favorite RENAME COLUMN user_sub TO user_email;

ALTER TABLE asset_grant RENAME COLUMN created_by_sub TO created_by_email;

ALTER TABLE acl_entry RENAME COLUMN created_by_sub TO created_by_email;
ALTER TABLE acl_entry RENAME COLUMN subject_sub    TO subject_email;

ALTER TABLE asset_version RENAME COLUMN edited_by_sub TO edited_by_email;

ALTER TABLE asset RENAME COLUMN archived_by_sub TO archived_by_email;
ALTER TABLE asset RENAME COLUMN updated_by_sub  TO updated_by_email;
ALTER TABLE asset RENAME COLUMN created_by_sub  TO created_by_email;

ALTER TABLE folder RENAME COLUMN archived_by_sub TO archived_by_email;
ALTER TABLE folder RENAME COLUMN updated_by_sub  TO updated_by_email;
ALTER TABLE folder RENAME COLUMN created_by_sub  TO created_by_email;

DROP TABLE IF EXISTS app_user;
-- +goose StatementEnd
