-- Archiving a folder hides everything beneath it. folder_access and
-- asset_access now return 0 when the item or any folder above it is archived
-- or deleted, so listings, direct links, search and MCP all agree. Passing
-- p_include_archived = true resolves the role regardless, for listing and
-- restoring archived items.

-- +goose Up
-- +goose StatementBegin
DROP FUNCTION asset_access(text, uuid);
DROP FUNCTION folder_access(text, uuid);
-- +goose StatementEnd

-- +goose StatementBegin
-- folder_hidden reports whether a folder or any folder above it is archived or
-- deleted.
CREATE FUNCTION folder_hidden(p_folder uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, archived_at, deleted_at, 0 AS depth
    FROM folder WHERE id = p_folder
    UNION ALL
    SELECT f.id, f.parent_id, f.archived_at, f.deleted_at, c.depth + 1
    FROM folder f JOIN chain c ON f.id = c.parent_id
    WHERE c.depth < 64
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE archived_at IS NOT NULL OR deleted_at IS NOT NULL)
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION folder_access(p_sub text, p_folder uuid, p_include_archived boolean DEFAULT false) RETURNS int
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE chain AS (
    SELECT id, parent_id, created_by_sub, 0 AS depth
    FROM folder WHERE id = p_folder
    UNION ALL
    SELECT f.id, f.parent_id, f.created_by_sub, c.depth + 1
    FROM folder f JOIN chain c ON f.id = c.parent_id
    WHERE c.depth < 64
  )
  SELECT CASE
    WHEN NOT p_include_archived AND folder_hidden(p_folder) THEN 0
    ELSE COALESCE(
      (SELECT 3 FROM chain WHERE created_by_sub = p_sub LIMIT 1),
      (SELECT CASE e.role WHEN 'EDITOR' THEN 2 ELSE 1 END
       FROM chain c JOIN acl_entry e ON e.folder_id = c.id AND e.subject_sub = p_sub
       ORDER BY c.depth LIMIT 1),
      0)
  END
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION asset_access(p_sub text, p_asset uuid, p_include_archived boolean DEFAULT false) RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT p_include_archived
         AND (a.archived_at IS NOT NULL OR a.deleted_at IS NOT NULL
              OR (a.folder_id IS NOT NULL AND folder_hidden(a.folder_id))) THEN 0
    WHEN a.created_by_sub = p_sub THEN 3
    WHEN fa.level = 3 THEN 3
    ELSE COALESCE(
      (SELECT CASE e.role WHEN 'EDITOR' THEN 2 ELSE 1 END
       FROM acl_entry e WHERE e.asset_id = a.id AND e.subject_sub = p_sub),
      fa.level)
  END
  FROM asset a
  CROSS JOIN LATERAL (
    -- Visibility is settled above, so resolve the folder role regardless.
    SELECT CASE WHEN a.folder_id IS NULL THEN 0
                ELSE folder_access(p_sub, a.folder_id, true) END AS level
  ) fa
  WHERE a.id = p_asset
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP FUNCTION asset_access(text, uuid, boolean);
DROP FUNCTION folder_access(text, uuid, boolean);
DROP FUNCTION folder_hidden(uuid);
-- +goose StatementEnd
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
