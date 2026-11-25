-- Anonymous visitors of public links (docs/page-apps.md, "Anonymous
-- visitors"). A visitor is one browser on one link: its secret lives in a
-- cookie, only its sha256 (hex) is stored. It keeps the page's localStorage
-- in page_data, as a signed-in user does, under the subject
-- 'anon:' || visitor_hash, which no OIDC sub can be; link_id and
-- visitor_hash tie those rows to it, so they go with it.
--
-- Anything that reads page_data per user (export, statistics, cleanup on
-- unshare) must filter link_id IS NULL.
--
-- The runner keeps a visitor's backend database (userDb) under the same
-- subject. When a visitor goes (its link revoked, or unused for 90 days), a
-- row in visitor_cleanup asks specola to delete that database too, which it
-- does when the runner can be reached (server.SweepVisitors).

-- +goose Up
-- +goose StatementBegin
ALTER TABLE public_link ADD CONSTRAINT public_link_id_asset_key UNIQUE (id, asset_id);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TABLE public_visitor (
  link_id      uuid        NOT NULL,
  visitor_hash text        NOT NULL CHECK (visitor_hash ~ '^[0-9a-f]{64}$'),
  asset_id     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (link_id, visitor_hash),
  UNIQUE (link_id, visitor_hash, asset_id),
  FOREIGN KEY (link_id, asset_id) REFERENCES public_link (id, asset_id) ON DELETE CASCADE
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX public_visitor_seen_idx ON public_visitor (last_seen_at);
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE page_data
  ADD COLUMN link_id uuid,
  ADD COLUMN visitor_hash text,
  ADD CONSTRAINT page_data_visitor_ck CHECK (
    (link_id IS NULL AND visitor_hash IS NULL AND user_sub NOT LIKE 'anon:%') OR
    (link_id IS NOT NULL AND visitor_hash IS NOT NULL AND user_sub = 'anon:' || visitor_hash)),
  ADD CONSTRAINT page_data_visitor_fk FOREIGN KEY (link_id, visitor_hash, asset_id)
    REFERENCES public_visitor (link_id, visitor_hash, asset_id) ON DELETE CASCADE;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX page_data_link_idx ON page_data (link_id) WHERE link_id IS NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TABLE visitor_cleanup (
  asset_id     uuid        NOT NULL,
  visitor_hash text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, visitor_hash)
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION public_visitor_gone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO visitor_cleanup (asset_id, visitor_hash) VALUES (OLD.asset_id, OLD.visitor_hash)
  ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE TRIGGER public_visitor_gone AFTER DELETE ON public_visitor
  FOR EACH ROW EXECUTE FUNCTION public_visitor_gone();
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS public_visitor_gone ON public_visitor;
DROP FUNCTION IF EXISTS public_visitor_gone();
DROP TABLE IF EXISTS visitor_cleanup;
DROP INDEX IF EXISTS page_data_link_idx;
DELETE FROM page_data WHERE link_id IS NOT NULL;
ALTER TABLE page_data DROP CONSTRAINT IF EXISTS page_data_visitor_fk,
  DROP CONSTRAINT IF EXISTS page_data_visitor_ck, DROP COLUMN IF EXISTS link_id, DROP COLUMN IF EXISTS visitor_hash;
DROP TABLE IF EXISTS public_visitor;
ALTER TABLE public_link DROP CONSTRAINT IF EXISTS public_link_id_asset_key;
-- +goose StatementEnd
