-- Public links: a page's owner can hand out a secret URL that shows the page,
-- read-only, to anyone who has it, without signing in. Only the token's sha256
-- is stored. A link shows the current version, or the one it is pinned to;
-- it stops working when it expires, is revoked (the row is deleted), the page
-- is archived, or its creator no longer owns the page.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE public_link (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  secret_hash    text NOT NULL UNIQUE,
  version        int,
  label          text,
  created_by_sub text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  last_used_at   timestamptz,
  views          bigint NOT NULL DEFAULT 0
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX public_link_asset_idx ON public_link (asset_id);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS public_link;
-- +goose StatementEnd
