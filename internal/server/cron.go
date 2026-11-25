package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Scheduled jobs (docs/page-backends.md, "Scheduled jobs (step 5)"). Specola
// owns the schedule (store/cron.go): every cronEvery the ticker claims the
// jobs that are due, which moves each one's next run past now in the same
// transaction (so a replica never runs a slot another one claimed, and
// missed slots are not caught up), and calls the runner's POST /scheduled
// for each, at most cronConcurrency at once in this process. The outcome
// goes to backend_cron's last_* columns, which owners and editors read at
// GET /api/pages/{id}/backend/cron.

const (
	// cronEvery is how often due jobs are looked for. Slots are a minute
	// apart, so a job runs within this much of its time.
	cronEvery = 30 * time.Second
	// cronConcurrency bounds the jobs running at once in this process; the
	// others wait for a later tick, here or on another replica.
	cronConcurrency = 4
)

// cronState is the ticker's state on a Server.
type cronState struct {
	// every is the tick; 0 is cronEvery. Tests shorten it.
	every time.Duration
	once  sync.Once
	// slots holds a token per job running.
	slots chan struct{}
	// running counts the jobs running, so tests (and shutdown) can wait.
	running sync.WaitGroup
}

func (c *cronState) init() {
	c.once.Do(func() { c.slots = make(chan struct{}, cronConcurrency) })
}

// routesCron registers the scheduled jobs' routes, under /api (session).
func (s *Server) routesCron(r chi.Router) {
	r.Get("/pages/{id}/backend/cron", s.handleBackendCron)
}

// handleBackendCron lists a page's scheduled jobs and their last runs, for
// its owners and editors.
func (s *Server) handleBackendCron(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	jobs, err := s.st.BackendCronJobs(ctx, subOf(ctx), chi.URLParam(r, "id"))
	if err != nil {
		backendAccessError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeJSON(w, http.StatusOK, map[string][]store.CronJobInfo{"jobs": jobs})
}

// RunCron runs the pages' scheduled jobs until ctx ends: it first brings
// the schedule in line with the pages' current versions (for pages
// published before scheduled jobs existed), then ticks. Without backends it
// returns at once.
func (s *Server) RunCron(ctx context.Context) {
	if s.runner == nil {
		return
	}
	if _, err := s.st.SyncAllBackendCron(ctx); err != nil {
		slog.Warn("scheduled jobs: sync", "err", err)
	}
	every := s.cron.every
	if every <= 0 {
		every = cronEvery
	}
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		s.cronTick(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// cronTick claims as many due jobs as there are free slots and starts them.
// It returns how many it started; they run in the background (wait on
// s.cron.running).
func (s *Server) cronTick(ctx context.Context) int {
	s.cron.init()
	// Only the tick takes slots, so this many are free until it does.
	free := cap(s.cron.slots) - len(s.cron.slots)
	if free == 0 {
		return 0
	}
	due, err := s.st.ClaimDueCron(ctx, s.now(), free)
	if err != nil {
		if ctx.Err() == nil {
			slog.Warn("scheduled jobs: claim", "err", err)
		}
		return 0
	}
	for _, d := range due {
		s.cron.slots <- struct{}{}
		s.cron.running.Add(1)
		go func() {
			defer s.cron.running.Done()
			defer func() { <-s.cron.slots }()
			s.runCronJob(ctx, d)
		}()
	}
	return len(due)
}

// runCronJob runs one claimed job on the runner and records the outcome.
func (s *Server) runCronJob(ctx context.Context, d store.DueCron) {
	at, started := s.now(), time.Now()
	record := func(status, errText string, ran bool) {
		var took *time.Duration
		if ran {
			dur := time.Since(started)
			took = &dur
		}
		// Recorded even when ctx ended (shutdown): the run happened, or
		// was cut short, and the owner should see which.
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := s.st.RecordCronRun(rctx, d.AssetID, d.Name, at, status, errText, took); err != nil {
			slog.Warn("scheduled jobs: record", "page", d.AssetID, "job", d.Name, "err", err)
		}
		if status != backend.CronOK {
			slog.Info("scheduled job", "page", d.AssetID, "job", d.Name, "status", status, "error", errText)
		}
	}

	t, err := s.st.CronTarget(ctx, d.AssetID)
	if errors.Is(err, store.ErrNotFound) {
		// Archived since it was claimed.
		record(backend.CronSkipped, "the page is archived", false)
		return
	}
	if err != nil {
		record(backend.CronError, "specola could not read the page: "+err.Error(), false)
		return
	}
	if t.Manifest == nil || !slices.ContainsFunc(t.Manifest.Cron, func(j backend.CronJob) bool { return j.Name == d.Name }) {
		// A new version dropped the job since it was claimed: its row is
		// gone, nothing to run or record.
		return
	}
	if !s.runner.Available() {
		// Known down (health check): skipped, as for an archived page. A
		// call that can't reach it is "unavailable" (below).
		record(backend.CronSkipped, "the backend runner is not available", false)
		return
	}
	secrets, egress, err := s.backendSecretsAndEgress(ctx, t.ID, *t.Manifest)
	if err != nil {
		slog.Error("scheduled jobs: secrets", "page", t.ID, "err", err)
		record(backend.CronError, "specola could not read the page's secrets", false)
		return
	}
	res, err := s.runner.Scheduled(ctx, backend.ScheduledHead{
		Page:      backend.Page{ID: t.ID, Version: t.Version, Title: t.Title},
		VersionID: t.VersionID,
		CodeHash:  t.CodeHash,
		Role:      "cron",
		Secrets:   secrets,
		Egress:    egress,
		Event:     backend.Event{Name: d.Name, ScheduledTime: d.Slot.UnixMilli()},
	})
	switch {
	case err != nil && backend.Unreachable(err):
		s.runner.MarkUnavailable()
		record(backend.CronUnavailable, "the backend runner could not be reached", false)
		return
	case err != nil && errors.Is(err, context.DeadlineExceeded):
		record(backend.CronTimeout, "the runner did not answer in time", true)
		return
	case err != nil:
		record(backend.CronError, "the runner stopped before answering: "+err.Error(), true)
		return
	}
	if res.Status != backend.CronUnavailable {
		// The runner ran the page's code: it has data from now on.
		s.markBackendUsed(ctx, t.ID)
	}
	record(res.Status, cronErrorText(res), res.Status != backend.CronUnavailable)
}

// cronErrorText is last_error for a result: its message and the ref of its
// log line, when there are any.
func cronErrorText(res backend.ScheduledResult) string {
	switch {
	case res.Ref != "" && res.Message != "":
		return res.Message + " (ref " + res.Ref + ")"
	case res.Ref != "":
		return "see the backend log (ref " + res.Ref + ")"
	}
	return res.Message
}
