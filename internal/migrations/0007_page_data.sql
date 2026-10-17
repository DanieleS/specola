-- Key-value data a page keeps for each user who views it, in place of the
-- localStorage its sandbox denies it. Private to that user; the page reaches it
-- through the viewer (window.specola.storage), never directly.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE page_data (
  asset_id   uuid NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
  user_sub   text NOT NULL,
  key        text NOT NULL,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, user_sub, key)
);
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS page_data;
-- +goose StatementEnd
