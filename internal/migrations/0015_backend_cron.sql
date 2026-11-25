-- Page backends, scheduled jobs (docs/page-backends.md, "Scheduled jobs
-- (step 5)"). One row per job the current version of a page declares,
-- rewritten in the transaction that changes the current version (keeping
-- last_* for a job whose name stays). next_run_at is the next slot, in UTC;
-- NULL for a schedule that never fires (a 31 February). The ticker claims
-- due rows with FOR UPDATE SKIP LOCKED and moves next_run_at past now before
-- running them, so replicas never run one slot twice. last_status is the
-- outcome of the latest run: ok, no-handler, error, timeout (the runner's
-- answer), unavailable (the runner couldn't be reached) or skipped (the page
-- is archived). Rows for pages that existed before this migration are filled
-- in by specola at start (store.SyncAllBackendCron), which computes the slots.

-- +goose Up
-- +goose StatementBegin
CREATE TABLE backend_cron (
  asset_id         uuid        NOT NULL REFERENCES asset (id) ON DELETE CASCADE,
  name             text        NOT NULL,
  schedule         text        NOT NULL,
  next_run_at      timestamptz,
  last_run_at      timestamptz,
  last_status      text,
  last_error       text,
  last_duration_ms int,
  PRIMARY KEY (asset_id, name)
);
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX backend_cron_due_idx ON backend_cron (next_run_at) WHERE next_run_at IS NOT NULL;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS backend_cron;
-- +goose StatementEnd
