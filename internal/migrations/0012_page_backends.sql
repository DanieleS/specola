-- Page backends (docs/page-backends.md): a bundle version may carry server
-- code under .specola/, described by .specola/backend.json. backend is that
-- manifest, validated and with its defaults filled in; non-null marks a
-- backend version. backend_hash identifies the code: the sha256 of the lines
-- "<path>\t<sha256>\n" of every file under .specola/, sorted by path, so the
-- runner caches extracted code by it.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE asset_version ADD COLUMN backend jsonb;
ALTER TABLE asset_version ADD COLUMN backend_hash text;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE asset_version DROP COLUMN IF EXISTS backend_hash;
ALTER TABLE asset_version DROP COLUMN IF EXISTS backend;
-- +goose StatementEnd
