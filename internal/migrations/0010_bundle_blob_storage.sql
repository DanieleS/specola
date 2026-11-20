-- Bundle files are served in slices (Range requests, and large files read a
-- chunk at a time: docs/spa-bundles.md, Serving). Postgres can only fetch a
-- slice of a bytea without reading the whole value when the value is stored
-- uncompressed, so new blobs are stored out of line without compression.
-- Most large bundle files (images, fonts, wasm, media) are compressed already.

-- +goose Up
ALTER TABLE bundle_blob ALTER COLUMN content SET STORAGE EXTERNAL;

-- +goose Down
ALTER TABLE bundle_blob ALTER COLUMN content SET STORAGE EXTENDED;
