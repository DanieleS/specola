package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"

	"github.com/jackc/pgx/v5/pgxpool"
)

// cronRunner stands in for the runner's POST /scheduled: it records each
// head and answers by the job's name.
type cronRunner struct {
	*httptest.Server
	mu      sync.Mutex
	heads   []backend.ScheduledHead
	arrived chan string   // a "slow…" job started
	release chan struct{} // closed: "slow…" jobs answer
}

func newCronRunner(t *testing.T) *cronRunner {
	t.Helper()
	cr := &cronRunner{arrived: make(chan string, 100), release: make(chan struct{})}
	cr.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+runnerToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/health":
			io.WriteString(w, `{"ok":true,"version":"test"}`)
			return
		case "/scheduled":
		default:
			http.NotFound(w, r)
			return
		}
		var h backend.ScheduledHead
		raw, err := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Specola-Invoke"))
		if err != nil || json.Unmarshal(raw, &h) != nil {
			http.Error(w, "bad head", http.StatusBadRequest)
			return
		}
		cr.mu.Lock()
		cr.heads = append(cr.heads, h)
		cr.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasPrefix(h.Event.Name, "slow"):
			cr.arrived <- h.Event.Name
			<-cr.release
			io.WriteString(w, `{"status":"ok"}`)
		case h.Event.Name == "fail":
			io.WriteString(w, `{"status":"error","ref":"r7"}`)
		case h.Event.Name == "crash":
			w.Header().Set("X-Specola-Error", "backend-crashed")
			w.WriteHeader(http.StatusBadGateway)
			io.WriteString(w, `{"error":"backend-crashed","message":"the worker died"}`)
		default:
			io.WriteString(w, `{"status":"ok"}`)
		}
	}))
	t.Cleanup(cr.Close)
	return cr
}

func (cr *cronRunner) took() []backend.ScheduledHead {
	cr.mu.Lock()
	defer cr.mu.Unlock()
	out := cr.heads
	cr.heads = nil
	return out
}

// newCronServer runs Specola on pool with backends on cr and a fake clock
// at *now.
func newCronServer(t *testing.T, cr *cronRunner, pool *pgxpool.Pool, now *time.Time, mu *sync.Mutex) (*httptest.Server, *Server) {
	t.Helper()
	s := New(backendConfig(cr.URL), store.New(pool), nil, nil)
	s.now = func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		return *now
	}
	if !s.runner.Check(context.Background()) {
		t.Fatal("cron runner not healthy")
	}
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)
	return ts, s
}

// tick runs one round of the ticker and waits for the jobs it started.
func tick(s *Server) int {
	n := s.cronTick(context.Background())
	s.cron.running.Wait()
	return n
}

type cronJobs struct {
	Jobs []struct {
		Name, Schedule string
		NextRunAt      *time.Time
		LastRunAt      *time.Time
		LastStatus     *string
		LastError      *string
		LastDurationMs *int
	}
}

func listCron(t *testing.T, ts *httptest.Server, user, page string) cronJobs {
	t.Helper()
	code, body := call(t, ts, user, "GET", "/api/pages/"+page+"/backend/cron", "")
	if code != http.StatusOK {
		t.Fatalf("cron list: %d %s", code, body)
	}
	var j cronJobs
	mustJSON(t, body, &j)
	return j
}

func cronBundle(jobs string) files {
	return files{
		"index.html":                `<p>app</p>`,
		".specola/backend.json":     `{"version":1,"secrets":["API_KEY"],"egress":["api.example.com"],"cron":` + jobs + `}`,
		".specola/server/index.mjs": `export default { scheduled() {} }`,
	}
}

func TestCronTicker(t *testing.T) {
	cr := newCronRunner(t)
	pool := testdb.New(t)
	var mu sync.Mutex
	// Far enough ahead that every slot computed at publish time is due.
	now := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Minute).Add(20 * time.Second)
	ts, s := newCronServer(t, cr, pool, &now, &mu)
	setNow := func(t time.Time) { mu.Lock(); now = t; mu.Unlock() }

	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Jobs"}`),
		cronBundle(`[{"name":"ok","schedule":"* * * * *"},{"name":"fail","schedule":"*/5 * * * *"},{"name":"crash","schedule":"0 3 * * *"}]`), "")
	if code, body := call(t, ts, "alice", "PUT", "/api/pages/"+page+"/secrets/API_KEY", `{"value":"sk-cron"}`); code != http.StatusNoContent {
		t.Fatalf("set secret: %d %s", code, body)
	}
	j := listCron(t, ts, "alice", page)
	if len(j.Jobs) != 3 || j.Jobs[0].Name != "crash" || j.Jobs[0].NextRunAt == nil || j.Jobs[0].LastStatus != nil {
		t.Fatalf("jobs before = %+v", j)
	}
	slots := map[string]time.Time{}
	for _, job := range j.Jobs {
		slots[job.Name] = *job.NextRunAt
	}

	// One tick runs all three, as the cron role, with the page's secrets.
	if n := tick(s); n != 3 {
		t.Fatalf("started %d", n)
	}
	heads := cr.took()
	if len(heads) != 3 {
		t.Fatalf("runner got %d", len(heads))
	}
	for _, h := range heads {
		if h.Role != "cron" || h.User != nil || h.Link != nil || h.Page.ID != page || h.Page.Version != 1 || h.Page.Title != "Jobs" ||
			h.VersionID == "" || len(h.CodeHash) != 64 || h.Secrets["API_KEY"] != "sk-cron" || strings.Join(h.Egress, ",") != "api.example.com" ||
			h.Event.ScheduledTime != slots[h.Event.Name].UnixMilli() {
			t.Fatalf("head = %+v", h)
		}
	}
	j = listCron(t, ts, "alice", page)
	byName := map[string]int{}
	for i, job := range j.Jobs {
		byName[job.Name] = i
		if job.LastRunAt == nil || !job.LastRunAt.Equal(now) || job.NextRunAt == nil || !job.NextRunAt.After(now) {
			t.Fatalf("%s after run: %+v", job.Name, job)
		}
	}
	okJob, failJob, crashJob := j.Jobs[byName["ok"]], j.Jobs[byName["fail"]], j.Jobs[byName["crash"]]
	if *okJob.LastStatus != "ok" || okJob.LastError != nil || okJob.LastDurationMs == nil ||
		!okJob.NextRunAt.Equal(now.Truncate(time.Minute).Add(time.Minute)) {
		t.Fatalf("ok job: %+v", okJob)
	}
	if *failJob.LastStatus != "error" || failJob.LastError == nil || !strings.Contains(*failJob.LastError, "r7") {
		t.Fatalf("fail job: %+v", failJob)
	}
	if *crashJob.LastStatus != "error" || crashJob.LastError == nil || !strings.Contains(*crashJob.LastError, "the worker died") {
		t.Fatalf("crash job: %+v", crashJob)
	}

	// Same time again: nothing is due. A minute on: only the every-minute job.
	if n := tick(s); n != 0 {
		t.Fatalf("ran again: %d", n)
	}
	setNow(now.Add(time.Minute))
	if n := tick(s); n != 1 {
		t.Fatalf("a minute later: %d", n)
	}
	if h := cr.took(); len(h) != 1 || h[0].Event.Name != "ok" {
		t.Fatalf("a minute later: %+v", h)
	}

	// Down for days: one run each, then the next slot, no catch-up.
	setNow(now.Add(72 * time.Hour))
	if n := tick(s); n != 3 {
		t.Fatalf("after downtime: %d", n)
	}
	cr.took()
	if n := tick(s); n != 0 {
		t.Fatalf("caught up: %d", n)
	}

	// Runner known to be down: skipped (the doc's ticker bullet), not
	// called, recorded.
	setNow(now.Add(24 * time.Hour))
	s.runner.MarkUnavailable()
	if n := tick(s); n != 3 {
		t.Fatalf("unavailable: %d", n)
	}
	if h := cr.took(); len(h) != 0 {
		t.Fatalf("called while unavailable: %d", len(h))
	}
	for _, job := range listCron(t, ts, "alice", page).Jobs {
		if *job.LastStatus != "skipped" || job.LastDurationMs != nil || job.LastError == nil || *job.LastError != "the backend runner is not available" {
			t.Fatalf("runner down %+v", job)
		}
	}
	s.runner.Check(context.Background())

	// Archived: skipped, recorded, not called; unarchived, it runs again.
	if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+page+"/archive", ""); code != http.StatusNoContent {
		t.Fatal("archive")
	}
	setNow(now.Add(24 * time.Hour))
	if n := tick(s); n != 0 {
		t.Fatalf("archived ran %d", n)
	}
	if h := cr.took(); len(h) != 0 {
		t.Fatalf("called while archived: %d", len(h))
	}
	var status string
	if err := pool.QueryRow(context.Background(), `SELECT last_status FROM backend_cron WHERE name = 'ok'`).Scan(&status); err != nil || status != "skipped" {
		t.Fatalf("archived status %q %v", status, err)
	}
	if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+page+"/unarchive", ""); code != http.StatusNoContent {
		t.Fatal("unarchive")
	}
	setNow(now.Add(24 * time.Hour))
	if n := tick(s); n != 3 {
		t.Fatalf("unarchived: %d", n)
	}
	cr.took()

	// The runner gone: unavailable, and marked so.
	cr.Close()
	setNow(now.Add(24 * time.Hour))
	if n := tick(s); n != 3 {
		t.Fatalf("runner gone: %d", n)
	}
	if s.runner.Available() {
		t.Fatal("an unreachable runner is still available")
	}
	if status := *listCron(t, ts, "alice", page).Jobs[0].LastStatus; status != "unavailable" {
		t.Fatalf("runner gone: %s", status)
	}
}

func TestCronRoute(t *testing.T) {
	cr := newCronRunner(t)
	pool := testdb.New(t)
	var mu sync.Mutex
	now := time.Now()
	ts, _ := newCronServer(t, cr, pool, &now, &mu)
	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Jobs"}`), cronBundle(`[{"name":"a","schedule":"0 3 * * *"}]`), "")
	for user, role := range map[string]string{"ed": "editor", "viewer": "viewer"} {
		if code, body := call(t, ts, "alice", "PUT", "/api/pages/"+page+"/acl", `{"sub":"`+user+`","role":"`+role+`"}`); code != http.StatusNoContent {
			t.Fatalf("share: %d %s", code, body)
		}
	}
	code, body := call(t, ts, "ed", "GET", "/api/pages/"+page+"/backend/cron", "")
	if code != http.StatusOK || !strings.HasPrefix(body, `{"jobs":[{"name":"a","schedule":"0 3 * * *","nextRunAt":"`) ||
		strings.Contains(body, "lastRunAt") {
		t.Fatalf("editor: %d %s", code, body)
	}
	get := func(user string) *http.Response {
		r, _ := http.NewRequest("GET", ts.URL+"/api/pages/"+page+"/backend/cron", nil)
		r.Header.Set(userHeader, user)
		return mustDo(t, r)
	}
	wantBackendError(t, get("viewer"), http.StatusForbidden, "forbidden")
	wantBackendError(t, get("mallory"), http.StatusNotFound, "not-found")
	// A page without a backend has no jobs.
	plain := newPlainPage(t, ts, "alice")
	if code, body := call(t, ts, "alice", "GET", "/api/pages/"+plain+"/backend/cron", ""); code != http.StatusOK || body != `{"jobs":[]}`+"\n" {
		t.Fatalf("plain: %d %s", code, body)
	}
}

func TestCronConcurrencyLimit(t *testing.T) {
	cr := newCronRunner(t)
	pool := testdb.New(t)
	var mu sync.Mutex
	now := time.Now().UTC().Add(time.Hour)
	ts, s := newCronServer(t, cr, pool, &now, &mu)
	var jobs []string
	for i := range 6 {
		jobs = append(jobs, fmt.Sprintf(`{"name":"slow%d","schedule":"* * * * *"}`, i))
	}
	publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"Slow"}`), cronBundle("["+strings.Join(jobs, ",")+"]"), "")

	ctx := context.Background()
	if n := s.cronTick(ctx); n != cronConcurrency {
		t.Fatalf("first tick started %d", n)
	}
	for range cronConcurrency {
		<-cr.arrived
	}
	// Every slot is taken: the others wait, still due.
	if n := s.cronTick(ctx); n != 0 {
		t.Fatalf("second tick started %d", n)
	}
	close(cr.release)
	s.cron.running.Wait()
	if n := tick(s); n != 2 {
		t.Fatalf("third tick started %d", n)
	}
	if h := cr.took(); len(h) != 6 {
		t.Fatalf("runner got %d", len(h))
	}
}

// Two Specola replicas on one database, ticking at once: each slot runs
// once.
func TestCronNoDoubleFire(t *testing.T) {
	cr := newCronRunner(t)
	pool := testdb.New(t)
	var mu sync.Mutex
	now := time.Now().UTC().Add(time.Hour)
	ts, s1 := newCronServer(t, cr, pool, &now, &mu)
	_, s2 := newCronServer(t, cr, pool, &now, &mu)
	for p := range 3 {
		var jobs []string
		for i := range 5 {
			jobs = append(jobs, fmt.Sprintf(`{"name":"j%d","schedule":"* * * * *"}`, i))
		}
		publishBundle(t, ts, mintBundle(t, ts, "alice", fmt.Sprintf(`{"kind":"new","title":"P%d"}`, p)), cronBundle("["+strings.Join(jobs, ",")+"]"), "")
	}
	for round := range 3 {
		var wg sync.WaitGroup
		for _, s := range []*Server{s1, s2} {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for range 5 {
					tick(s)
				}
			}()
		}
		wg.Wait()
		seen := map[string]int{}
		for _, h := range cr.took() {
			seen[h.Page.ID+"/"+h.Event.Name]++
		}
		if len(seen) != 15 {
			t.Fatalf("round %d: %d jobs ran, want 15", round, len(seen))
		}
		for k, n := range seen {
			if n != 1 {
				t.Fatalf("round %d: %s ran %d times", round, k, n)
			}
		}
		mu.Lock()
		now = now.Add(time.Minute)
		mu.Unlock()
	}
}

func TestRunCronTicks(t *testing.T) {
	cr := newCronRunner(t)
	pool := testdb.New(t)
	var mu sync.Mutex
	now := time.Now().UTC().Add(time.Hour)
	ts, s := newCronServer(t, cr, pool, &now, &mu)
	page, _ := publishBundle(t, ts, mintBundle(t, ts, "alice", `{"kind":"new","title":"T"}`), cronBundle(`[{"name":"a","schedule":"* * * * *"}]`), "")
	// As if published before scheduled jobs existed: RunCron fills it in.
	if _, err := pool.Exec(context.Background(), `DELETE FROM backend_cron`); err != nil {
		t.Fatal(err)
	}
	s.cron.every = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.RunCron(ctx); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for len(listCron(t, ts, "alice", page).Jobs) == 0 || listCron(t, ts, "alice", page).Jobs[0].LastStatus == nil {
		if time.Now().After(deadline) {
			t.Fatal("RunCron didn't run the job")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	<-done
	s.cron.running.Wait()
	if h := cr.took(); len(h) != 1 {
		t.Fatalf("runner got %d", len(h))
	}
}
