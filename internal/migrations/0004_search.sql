-- Full-text search: one search_document per page with its name and the text
-- of its current version, rebuilt whenever a version is created. The 'simple'
-- configuration does no stemming, which keeps matching predictable across
-- languages; the name weighs more than the body.

-- +goose Up
-- +goose StatementBegin
-- html_text reduces an HTML document to its visible text: script and style
-- blocks and comments dropped, tags replaced by spaces, common entities
-- decoded, whitespace collapsed. Capped so the tsvector stays well under its
-- 1 MB limit.
CREATE FUNCTION html_text(html text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT left(btrim(
    regexp_replace(
      replace(replace(replace(replace(replace(replace(
        regexp_replace(
          regexp_replace(regexp_replace(regexp_replace(html,
            '<script\M.*?</script\s*>', ' ', 'gi'),
            '<style\M.*?</style\s*>', ' ', 'gi'),
            '<!--.*?-->', ' ', 'g'),
          '<[^>]*>', ' ', 'g'),
        '&nbsp;', ' '), '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&'),
      '\s+', ' ', 'g')),
    200000)
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE TABLE search_document (
  asset_id   uuid PRIMARY KEY REFERENCES asset(id) ON DELETE CASCADE,
  name       text NOT NULL,
  body       text NOT NULL,
  tsv        tsvector GENERATED ALWAYS AS (
               setweight(to_tsvector('simple', name), 'A') ||
               setweight(to_tsvector('simple', body), 'B')) STORED,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX search_document_tsv_idx ON search_document USING gin (tsv);
-- +goose StatementEnd

-- +goose StatementBegin
INSERT INTO search_document (asset_id, name, body)
SELECT a.id, a.name, html_text(v.content)
FROM asset a JOIN asset_version v ON v.asset_id = a.id AND v.version = a.current_version;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS search_document;
DROP FUNCTION IF EXISTS html_text(text);
-- +goose StatementEnd
