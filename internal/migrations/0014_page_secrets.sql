-- Page backends, secrets (docs/page-backends.md, "Secrets (step 3)"). Values
-- a page's owners set for the names its backend declares, passed to the
-- runner per call and never read back by anyone. AES-256-GCM with
-- SPECOLA_SECRETS_KEY, a fresh 12-byte nonce per write, and the associated
-- data asset_id || 0x00 || name, so a ciphertext copied to another page or
-- name doesn't decrypt. updated_by is the owner's sub.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE page_secret (
  asset_id   uuid        NOT NULL REFERENCES asset (id) ON DELETE CASCADE,
  name       text        NOT NULL,
  ciphertext bytea       NOT NULL,
  nonce      bytea       NOT NULL,
  updated_by text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, name)
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS page_secret;
-- +goose StatementEnd
