-- An optional note on each version saying what changed, written by whoever
-- publishes it (often an agent). An upload grant carries the note until the
-- upload that redeems it creates the version.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE asset_version ADD COLUMN note text;
ALTER TABLE asset_grant   ADD COLUMN note text;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE asset_grant   DROP COLUMN IF EXISTS note;
ALTER TABLE asset_version DROP COLUMN IF EXISTS note;
-- +goose StatementEnd
