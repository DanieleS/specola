package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/danieles/specola/internal/backend"

	"github.com/jackc/pgx/v5"
)

// Scheduled jobs (docs/page-backends.md, "Scheduled jobs (step 5)"): the
// jobs of the current version of every backend page, one backend_cron row
// each, with the next slot it is due at. The rows follow the current version:
// whatever changes it (a commit, a restore, a plain new version) calls
// syncBackendCron in the same transaction. The server's ticker claims due
// rows (ClaimDueCron), runs them on the runner and records the outcome
// (RecordCronRun).

// CronJobInfo is a page's scheduled job as owners and editors see it.
// NextRunAt is nil for a schedule that never fires (a 31 February).
type CronJobInfo struct {
	Name           string     `json:"name"`
	Schedule       string     `json:"schedule"`
	NextRunAt      *time.Time `json:"nextRunAt"`
	LastRunAt      *time.Time `json:"lastRunAt,omitempty"`
	LastStatus     *string    `json:"lastStatus,omitempty"`
	LastError      *string    `json:"lastError,omitempty"`
	LastDurationMs *int       `json:"lastDurationMs,omitempty"`
}

// syncBackendCron rewrites page assetID's backend_cron rows from its current
// version's manifest: the jobs it declares are upserted, keeping the last
// run of a job whose name stays (and its next slot, if its schedule stays
// too), and the others are deleted. now is what new slots come after.
func syncBackendCron(ctx context.Context, q querier, assetID string, now time.Time) error {
	var raw []byte
	err := q.QueryRow(ctx, `
		SELECT cur.backend FROM asset a
		JOIN asset_version cur ON cur.asset_id = a.id AND cur.version = a.current_version
		WHERE a.id = $1::uuid`, assetID).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	var jobs []backend.CronJob
	if raw != nil {
		var m backend.Manifest
		if err := json.Unmarshal(raw, &m); err != nil {
			return err
		}
		jobs = m.Cron
	}
	names := make([]string, 0, len(jobs))
	schedules := make([]string, 0, len(jobs))
	nexts := make([]*time.Time, 0, len(jobs))
	for _, j := range jobs {
		c, err := backend.ParseCron(j.Schedule)
		if err != nil {
			// Stored manifests were validated: this is a bug, not bad input.
			return err
		}
		var next *time.Time
		if t, ok := c.Next(now); ok {
			next = &t
		}
		names, schedules, nexts = append(names, j.Name), append(schedules, j.Schedule), append(nexts, next)
	}
	if _, err := q.Exec(ctx, `DELETE FROM backend_cron WHERE asset_id = $1::uuid AND NOT (name = ANY($2::text[]))`, assetID, names); err != nil {
		return err
	}
	if len(names) == 0 {
		return nil
	}
	_, err = q.Exec(ctx, `
		INSERT INTO backend_cron (asset_id, name, schedule, next_run_at)
		SELECT $1::uuid, n, s, x FROM unnest($2::text[], $3::text[], $4::timestamptz[]) AS j(n, s, x)
		ON CONFLICT (asset_id, name) DO UPDATE SET
		  schedule = EXCLUDED.schedule,
		  next_run_at = CASE WHEN backend_cron.schedule = EXCLUDED.schedule
		                     THEN backend_cron.next_run_at ELSE EXCLUDED.next_run_at END`,
		assetID, names, schedules, nexts)
	return err
}

// SyncAllBackendCron brings every page's backend_cron rows in line with its
// current version. Versions rewrite them as they change; this fills them in
// for pages whose backend version predates the table, and is harmless
// otherwise (rows that match are left as they are). It returns how many
// pages it looked at.
func (s *Store) SyncAllBackendCron(ctx context.Context) (int, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.id::text FROM asset a
		JOIN asset_version cur ON cur.asset_id = a.id AND cur.version = a.current_version
		WHERE jsonb_array_length(COALESCE(cur.backend->'cron', '[]'::jsonb)) > 0
		UNION
		SELECT DISTINCT asset_id::text FROM backend_cron`)
	if err != nil {
		return 0, err
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return 0, err
	}
	for _, id := range ids {
		if err := s.inTx(ctx, func(tx pgx.Tx) error {
			// The page's row first: a new version takes it too, so this
			// waits for one being committed rather than racing it.
			if _, err := tx.Exec(ctx, `SELECT 1 FROM asset WHERE id = $1::uuid FOR UPDATE`, id); err != nil {
				return err
			}
			return syncBackendCron(ctx, tx, id, time.Now())
		}); err != nil {
			return 0, err
		}
	}
	return len(ids), nil
}

// BackendCronJobs lists the scheduled jobs of a page sub owns or edits, by
// name.
func (s *Store) BackendCronJobs(ctx context.Context, sub, pageID string) ([]CronJobInfo, error) {
	if err := checkPage(ctx, s.pool, pageID, sub, RoleEditor); err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT name, schedule, next_run_at, last_run_at, last_status, last_error, last_duration_ms
		FROM backend_cron WHERE asset_id = $1::uuid ORDER BY name`, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	jobs := []CronJobInfo{}
	for rows.Next() {
		var j CronJobInfo
		if err := rows.Scan(&j.Name, &j.Schedule, &j.NextRunAt, &j.LastRunAt, &j.LastStatus, &j.LastError, &j.LastDurationMs); err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, rows.Err()
}

// DueCron is a scheduled job claimed to run now: Slot is when it was due.
type DueCron struct {
	AssetID, Name string
	Slot          time.Time
}

// cronClaimBatch bounds the due rows one claim looks at.
const cronClaimBatch = 100

// ClaimDueCron claims up to limit jobs due at now (next_run_at <= now) to run
// them, oldest slot first. Each claimed row's next_run_at moves to the
// schedule's next slot after now, in the same transaction, so missed slots
// are not caught up and no other claim, by this process or another replica,
// gets that slot again: rows are locked FOR UPDATE SKIP LOCKED, so two
// claims at once take different rows instead of waiting for each other.
//
// Jobs of pages that are archived (themselves or through a folder) are not
// run: their slot passes as for the others and they are recorded as
// skipped, in the same transaction, without counting towards limit.
func (s *Store) ClaimDueCron(ctx context.Context, now time.Time, limit int) ([]DueCron, error) {
	var due []DueCron
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `
			SELECT c.asset_id::text, c.name, c.schedule, c.next_run_at,
			       a.deleted_at IS NOT NULL OR backend_dormant_since(a.id) IS NOT NULL
			FROM backend_cron c JOIN asset a ON a.id = c.asset_id
			WHERE c.next_run_at <= $1
			ORDER BY c.next_run_at
			LIMIT $2
			FOR UPDATE OF c SKIP LOCKED`, now, cronClaimBatch)
		if err != nil {
			return err
		}
		type row struct {
			DueCron
			schedule string
			dormant  bool
		}
		var claimed []row
		for rows.Next() {
			var r row
			if err := rows.Scan(&r.AssetID, &r.Name, &r.schedule, &r.Slot, &r.dormant); err != nil {
				rows.Close()
				return err
			}
			claimed = append(claimed, r)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, r := range claimed {
			if !r.dormant && len(due) >= limit {
				// Left due, and unlocked at commit: the next claim, here or
				// on another replica, takes it.
				continue
			}
			var next *time.Time
			if t, ok := backend.NextRun(r.schedule, now); ok {
				next = &t
			}
			if r.dormant {
				_, err = tx.Exec(ctx, `
					UPDATE backend_cron SET next_run_at = $3, last_run_at = $4, last_status = $5,
					       last_error = 'the page is archived', last_duration_ms = NULL
					WHERE asset_id = $1::uuid AND name = $2`, r.AssetID, r.Name, next, now, backend.CronSkipped)
			} else {
				_, err = tx.Exec(ctx, `UPDATE backend_cron SET next_run_at = $3 WHERE asset_id = $1::uuid AND name = $2`,
					r.AssetID, r.Name, next)
				due = append(due, r.DueCron)
			}
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return due, nil
}

// RecordCronRun records the outcome of a job's run that started at. errText
// is the error's ref and message, "" for none; duration is nil when the job
// didn't run. A job that is gone meanwhile (a new version dropped it) is
// not an error.
func (s *Store) RecordCronRun(ctx context.Context, assetID, name string, at time.Time, status, errText string, duration *time.Duration) error {
	var ms *int
	if duration != nil {
		n := int(duration.Milliseconds())
		ms = &n
	}
	var e *string
	if errText != "" {
		e = &errText
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE backend_cron SET last_run_at = $3, last_status = $4, last_error = $5, last_duration_ms = $6
		WHERE asset_id = $1::uuid AND name = $2`, assetID, name, at, status, e, ms)
	return err
}

// CronTarget describes a scheduled run of page id's current version, as
// BackendTarget does a call, without a user: Role is RoleNone and User
// empty. It doesn't check access (nobody is calling), but an archived or
// deleted page is ErrNotFound, as for calls.
func (s *Store) CronTarget(ctx context.Context, id string) (*BackendTarget, error) {
	var (
		t        BackendTarget
		hash     *string
		manifest []byte
	)
	err := s.pool.QueryRow(ctx, `
		SELECT a.id::text, a.name, a.current_version, v.id::text, v.backend_hash, v.backend
		FROM asset a
		JOIN asset_version v ON v.asset_id = a.id AND v.version = a.current_version
		WHERE a.id = $1::uuid AND a.deleted_at IS NULL AND backend_dormant_since(a.id) IS NULL`, id).
		Scan(&t.ID, &t.Title, &t.Version, &t.VersionID, &hash, &manifest)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if manifest != nil {
		t.Manifest = &backend.Manifest{}
		if err := json.Unmarshal(manifest, t.Manifest); err != nil {
			return nil, err
		}
		if hash != nil {
			t.CodeHash = *hash
		}
	}
	return &t, nil
}
