-- Page backends, data lifecycle (docs/page-backends.md, "Data lifecycle").
-- backend_used_at says the runner holds data for the page: set on the first
-- call the runner answers, kept current at most once an hour, cleared when the
-- data is purged. The partial index keeps the hourly purge scan to the pages
-- that have data.
--
-- backend_dormant_since is when a page's backend data stopped being reachable:
-- the latest of when the page, or an archived folder above it, was archived,
-- and when its current version became current if that version has no backend.
-- NULL when neither holds (the data is live). Versions are never rewritten, a
-- restore adds one, so the current version's created_at is when it became
-- current; archive times are already kept on asset and folder.

-- +goose Up
-- +goose StatementBegin
ALTER TABLE asset ADD COLUMN backend_used_at timestamptz;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX asset_backend_used_idx ON asset (id) WHERE backend_used_at IS NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION backend_dormant_since(p_asset uuid) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT f.id, f.parent_id, f.archived_at, 0 AS depth
    FROM asset a JOIN folder f ON f.id = a.folder_id
    WHERE a.id = p_asset
    UNION ALL
    SELECT f.id, f.parent_id, f.archived_at, c.depth + 1
    FROM folder f JOIN chain c ON f.id = c.parent_id
    WHERE c.depth < 64
  )
  -- GREATEST ignores NULLs, and is NULL only when every argument is.
  SELECT GREATEST(a.archived_at,
                  (SELECT max(archived_at) FROM chain),
                  CASE WHEN cur.backend IS NULL THEN cur.created_at END)
  FROM asset a
  JOIN asset_version cur ON cur.asset_id = a.id AND cur.version = a.current_version
  WHERE a.id = p_asset
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION IF EXISTS backend_dormant_since(uuid);
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX IF EXISTS asset_backend_used_idx;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE asset DROP COLUMN IF EXISTS backend_used_at;
-- +goose StatementEnd
