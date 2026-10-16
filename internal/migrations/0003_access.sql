-- Access resolution for sharing. A user's access to an item is an int level:
--   0 none, 1 VIEWER, 2 EDITOR, 3 owner.
-- The owner of an item is whoever created it or any folder above it, so a page
-- an editor adds to your shared folder is still yours to manage. Otherwise the
-- nearest acl_entry for the user, on the item or up its folder chain, wins: a
-- VIEWER grant on a sub-folder narrows an EDITOR grant above it.
-- Archive and delete state is left to callers, which filter the item itself.

-- +goose Up
-- +goose StatementBegin
CREATE FUNCTION folder_access(p_sub text, p_folder uuid) RETURNS int
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, created_by_sub, 0 AS depth
    FROM folder WHERE id = p_folder
    UNION ALL
    SELECT f.id, f.parent_id, f.created_by_sub, c.depth + 1
    FROM folder f JOIN chain c ON f.id = c.parent_id
    WHERE c.depth < 64
  )
  SELECT COALESCE(
    (SELECT 3 FROM chain WHERE created_by_sub = p_sub LIMIT 1),
    (SELECT CASE e.role WHEN 'EDITOR' THEN 2 ELSE 1 END
     FROM chain c JOIN acl_entry e ON e.folder_id = c.id AND e.subject_sub = p_sub
     ORDER BY c.depth LIMIT 1),
    0)
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION asset_access(p_sub text, p_asset uuid) RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN a.created_by_sub = p_sub THEN 3
    WHEN fa.level = 3 THEN 3
    ELSE COALESCE(
      (SELECT CASE e.role WHEN 'EDITOR' THEN 2 ELSE 1 END
       FROM acl_entry e WHERE e.asset_id = a.id AND e.subject_sub = p_sub),
      fa.level)
  END
  FROM asset a
  CROSS JOIN LATERAL (
    SELECT CASE WHEN a.folder_id IS NULL THEN 0
                ELSE folder_access(p_sub, a.folder_id) END AS level
  ) fa
  WHERE a.id = p_asset
$$;
-- +goose StatementEnd

-- "Shared with me" looks grants up by subject.
-- +goose StatementBegin
CREATE INDEX acl_subject_idx ON acl_entry (subject_sub);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP INDEX IF EXISTS acl_subject_idx;
DROP FUNCTION IF EXISTS asset_access(text, uuid);
DROP FUNCTION IF EXISTS folder_access(text, uuid);
-- +goose StatementEnd
