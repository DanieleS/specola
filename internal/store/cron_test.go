package store

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/testdb"
)

// cronApp is a backend bundle with the given cron jobs (JSON).
func cronApp(jobs string) bundle {
	return bundle{
		"index.html":                `<p>app ` + jobs + `</p>`,
		".specola/backend.json":     `{"version":1,"cron":` + jobs + `}`,
		".specola/server/index.mjs": `export default {}`,
	}
}

func jobNames(jobs []CronJobInfo) string {
	var out []string
	for _, j := range jobs {
		out = append(out, j.Name+"="+j.Schedule)
	}
	return strings.Join(out, " ")
}

func TestBackendCronFollowsTheCurrentVersion(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	commit := func(page string, b bundle) int {
		t.Helper()
		req := GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: page, Bundle: true}
		if page == "" {
			req = GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "App", Bundle: true}
		}
		token, _, err := st.MintGrant(ctx, req, BundleGrantTTL)
		if err != nil {
			t.Fatal(err)
		}
		_, v := uploadBundle(t, st, token, b, "")
		return v
	}
	jobs := func(page string) []CronJobInfo {
		t.Helper()
		js, err := st.BackendCronJobs(ctx, "alice", page)
		if err != nil {
			t.Fatal(err)
		}
		return js
	}

	// A new page with two jobs.
	token, _, _ := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "App", Bundle: true}, BundleGrantTTL)
	page, _ := uploadBundle(t, st, token, cronApp(`[{"name":"nightly","schedule":"0 3 * * *"},{"name":"often","schedule":"*/5 * * * *"}]`), "")
	js := jobs(page)
	if jobNames(js) != "nightly=0 3 * * * often=*/5 * * * *" {
		t.Fatalf("v1 jobs = %s", jobNames(js))
	}
	before := time.Now()
	for _, j := range js {
		if j.NextRunAt == nil || !j.NextRunAt.After(before.Add(-time.Minute)) || j.NextRunAt.Second() != 0 || j.LastRunAt != nil || j.LastStatus != nil {
			t.Fatalf("job %+v", j)
		}
		if want, _ := backend.NextRun(j.Schedule, before.Add(-time.Minute)); j.NextRunAt.Before(want) {
			t.Fatalf("%s next %v, want ≥ %v", j.Name, j.NextRunAt, want)
		}
	}
	// A run recorded on both.
	ran := time.Date(2026, 1, 1, 3, 0, 0, 0, time.UTC)
	d := 1500 * time.Millisecond
	for _, n := range []string{"nightly", "often"} {
		if err := st.RecordCronRun(ctx, page, n, ran, "ok", "", &d); err != nil {
			t.Fatal(err)
		}
	}
	nightlyNext := *js[0].NextRunAt

	// v2: nightly stays as it is, often changes schedule, hourly is new.
	commit(page, cronApp(`[{"name":"nightly","schedule":"0 3 * * *"},{"name":"often","schedule":"*/10 * * * *"},{"name":"hourly","schedule":"0 * * * *"}]`))
	js = jobs(page)
	if jobNames(js) != "hourly=0 * * * * nightly=0 3 * * * often=*/10 * * * *" {
		t.Fatalf("v2 jobs = %s", jobNames(js))
	}
	if js[0].LastRunAt != nil || js[1].LastStatus == nil || *js[1].LastStatus != "ok" || !js[1].LastRunAt.Equal(ran) ||
		*js[1].LastDurationMs != 1500 || !js[1].NextRunAt.Equal(nightlyNext) || js[2].LastStatus == nil || js[2].NextRunAt.Minute()%10 != 0 {
		t.Fatalf("v2 kept the wrong things: %+v %+v %+v", js[0], js[1], js[2])
	}

	// v3: a backend without cron. Then v4: a plain page. Both drop the jobs.
	commit(page, cronApp(`[]`))
	if js := jobs(page); len(js) != 0 {
		t.Fatalf("v3 jobs = %s", jobNames(js))
	}
	commit(page, cronApp(`[{"name":"nightly","schedule":"0 3 * * *"}]`))
	if js := jobs(page); jobNames(js) != "nightly=0 3 * * *" {
		t.Fatalf("v4 jobs = %s", jobNames(js))
	}
	v5, err := st.AddVersion(ctx, page, "<p>static</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if js := jobs(page); len(js) != 0 {
		t.Fatalf("plain v%d jobs = %s", v5, jobNames(js))
	}

	// Restoring v2 brings its jobs back; restoring the plain one drops them.
	v6, err := st.RestoreVersion(ctx, "alice", page, 2, "")
	if err != nil {
		t.Fatal(err)
	}
	if js := jobs(page); jobNames(js) != "hourly=0 * * * * nightly=0 3 * * * often=*/10 * * * *" {
		t.Fatalf("restored v2 as v%d: jobs = %s", v6, jobNames(js))
	}
	if _, err := st.RestoreVersion(ctx, "alice", page, v5, ""); err != nil {
		t.Fatal(err)
	}
	if js := jobs(page); len(js) != 0 {
		t.Fatalf("restored plain: jobs = %s", jobNames(js))
	}

	// A plain upload through a grant drops them too.
	commit(page, cronApp(`[{"name":"nightly","schedule":"0 3 * * *"}]`))
	tok, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: page}, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.RedeemUpload(ctx, tok, "<p>uploaded</p>"); err != nil {
		t.Fatal(err)
	}
	if js := jobs(page); len(js) != 0 {
		t.Fatalf("uploaded plain: jobs = %s", jobNames(js))
	}

	// Who may list: owners and editors.
	commit(page, cronApp(`[{"name":"nightly","schedule":"0 3 * * *"}]`))
	_ = st.Share(ctx, "alice", KindPage, page, "ed", RoleEditor)
	_ = st.Share(ctx, "alice", KindPage, page, "viewer", RoleViewer)
	if js, err := st.BackendCronJobs(ctx, "ed", page); err != nil || len(js) != 1 {
		t.Fatalf("editor: %v %v", js, err)
	}
	if _, err := st.BackendCronJobs(ctx, "viewer", page); err != ErrForbidden {
		t.Fatalf("viewer: %v", err)
	}
	if _, err := st.BackendCronJobs(ctx, "mallory", page); err != ErrNotFound {
		t.Fatalf("stranger: %v", err)
	}

	// A schedule that never fires has no next run.
	commit(page, cronApp(`[{"name":"never","schedule":"0 0 30 2 *"}]`))
	if js := jobs(page); len(js) != 1 || js[0].NextRunAt != nil {
		t.Fatalf("never: %+v", js)
	}
}

func TestSyncAllBackendCron(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	token, _, _ := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "App", Bundle: true}, BundleGrantTTL)
	page, _ := uploadBundle(t, st, token, cronApp(`[{"name":"a","schedule":"0 3 * * *"}]`), "")
	// As before the table existed: no rows.
	if _, err := pool.Exec(ctx, `DELETE FROM backend_cron`); err != nil {
		t.Fatal(err)
	}
	// And a stray row for a page with no jobs.
	plain, _, _ := st.CreatePage(ctx, nil, "Plain", "<p>x</p>", "", "alice")
	if _, err := pool.Exec(ctx, `INSERT INTO backend_cron (asset_id, name, schedule, next_run_at) VALUES ($1::uuid, 'x', '* * * * *', now())`, plain); err != nil {
		t.Fatal(err)
	}
	if n, err := st.SyncAllBackendCron(ctx); err != nil || n != 2 {
		t.Fatalf("sync: %d %v", n, err)
	}
	if js, _ := st.BackendCronJobs(ctx, "alice", page); jobNames(js) != "a=0 3 * * *" || js[0].NextRunAt == nil {
		t.Fatalf("jobs = %+v", js)
	}
	if js, _ := st.BackendCronJobs(ctx, "alice", plain); len(js) != 0 {
		t.Fatalf("stray = %+v", js)
	}
}

func TestClaimDueCron(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	newPage := func(name, jobs string) string {
		t.Helper()
		token, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: name, Bundle: true}, BundleGrantTTL)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := uploadBundle(t, st, token, cronApp(jobs), "")
		return id
	}
	a := newPage("A", `[{"name":"j1","schedule":"* * * * *"},{"name":"j2","schedule":"*/5 * * * *"}]`)
	b := newPage("B", `[{"name":"j1","schedule":"0 3 * * *"}]`)
	now := time.Date(2030, 6, 1, 12, 7, 30, 0, time.UTC)
	setNext := func(page, name string, at time.Time) {
		t.Helper()
		if _, err := pool.Exec(ctx, `UPDATE backend_cron SET next_run_at = $3 WHERE asset_id = $1::uuid AND name = $2`, page, name, at); err != nil {
			t.Fatal(err)
		}
	}
	setNext(a, "j1", now.Add(-time.Minute))
	setNext(a, "j2", now.Add(-3*time.Hour)) // missed many slots while down
	setNext(b, "j1", now.Add(time.Second))  // not due yet

	// Limit 1: the oldest slot first; the other stays due.
	due, err := st.ClaimDueCron(ctx, now, 1)
	if err != nil || len(due) != 1 || due[0].AssetID != a || due[0].Name != "j2" || !due[0].Slot.Equal(now.Add(-3*time.Hour)) {
		t.Fatalf("claim 1: %+v %v", due, err)
	}
	due, err = st.ClaimDueCron(ctx, now, 10)
	if err != nil || len(due) != 1 || due[0].Name != "j1" || due[0].AssetID != a {
		t.Fatalf("claim 2: %+v %v", due, err)
	}
	// Claimed slots moved to the next one after now: no catch-up, no repeat.
	if due, _ := st.ClaimDueCron(ctx, now, 10); len(due) != 0 {
		t.Fatalf("claimed again: %+v", due)
	}
	js, _ := st.BackendCronJobs(ctx, "alice", a)
	if !js[0].NextRunAt.Equal(time.Date(2030, 6, 1, 12, 8, 0, 0, time.UTC)) || !js[1].NextRunAt.Equal(time.Date(2030, 6, 1, 12, 10, 0, 0, time.UTC)) {
		t.Fatalf("next = %v %v", js[0].NextRunAt, js[1].NextRunAt)
	}

	// Archived pages, and pages in an archived folder: skipped, recorded, and
	// moved on, without taking a slot from the limit.
	setNext(a, "j1", now)
	setNext(a, "j2", now)
	setNext(b, "j1", now)
	if err := st.Archive(ctx, "alice", KindPage, a); err != nil {
		t.Fatal(err)
	}
	due, err = st.ClaimDueCron(ctx, now, 1)
	if err != nil || len(due) != 1 || due[0].AssetID != b {
		t.Fatalf("claim with archived: %+v %v", due, err)
	}
	var status, lastErr string
	var next time.Time
	if err := pool.QueryRow(ctx, `SELECT last_status, last_error, next_run_at FROM backend_cron WHERE asset_id = $1::uuid AND name = 'j1'`, a).
		Scan(&status, &lastErr, &next); err != nil || status != "skipped" || lastErr == "" || !next.After(now) {
		t.Fatalf("archived row: %q %q %v %v", status, lastErr, next, err)
	}
	if _, err := st.CronTarget(ctx, a); err != ErrNotFound {
		t.Fatalf("archived target: %v", err)
	}
	if err := st.Unarchive(ctx, "alice", KindPage, a); err != nil {
		t.Fatal(err)
	}
	folder, err := st.CreateFolder(ctx, nil, "F", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Move(ctx, "alice", KindPage, a, &folder); err != nil {
		t.Fatal(err)
	}
	if err := st.Archive(ctx, "alice", KindFolder, folder); err != nil {
		t.Fatal(err)
	}
	setNext(a, "j1", now)
	if due, _ := st.ClaimDueCron(ctx, now, 10); len(due) != 0 {
		t.Fatalf("archived folder: %+v", due)
	}

	// The target of a run: the current version, no user.
	tgt, err := st.CronTarget(ctx, strings.ToUpper(b))
	if err != nil || tgt.ID != b || tgt.Version != 1 || tgt.Manifest == nil || len(tgt.Manifest.Cron) != 1 || tgt.CodeHash == "" || tgt.VersionID == "" || tgt.Title != "B" {
		t.Fatalf("target = %+v %v", tgt, err)
	}
}

// Two claimers at once, as two replicas: each due slot is claimed once.
func TestClaimDueCronConcurrent(t *testing.T) {
	pool := testdb.New(t)
	st, st2 := New(pool), New(pool)
	ctx := context.Background()
	var jobs []string
	for i := range 10 {
		jobs = append(jobs, fmt.Sprintf(`{"name":"j%d","schedule":"* * * * *"}`, i))
	}
	var pages []string
	for i := range 5 {
		token, _, _ := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: fmt.Sprint("P", i), Bundle: true}, BundleGrantTTL)
		id, _ := uploadBundle(t, st, token, cronApp("["+strings.Join(jobs, ",")+"]"), "")
		pages = append(pages, id)
	}
	now := time.Now().Add(time.Hour)
	for round := range 3 {
		if _, err := pool.Exec(ctx, `UPDATE backend_cron SET next_run_at = $1`, now.Add(-time.Minute)); err != nil {
			t.Fatal(err)
		}
		var mu sync.Mutex
		seen := map[string]int{}
		var wg sync.WaitGroup
		for w := range 8 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				s := st
				if w%2 == 1 {
					s = st2
				}
				for {
					due, err := s.ClaimDueCron(ctx, now, 3)
					if err != nil {
						t.Error(err)
						return
					}
					if len(due) == 0 {
						return
					}
					mu.Lock()
					for _, d := range due {
						seen[d.AssetID+"/"+d.Name]++
					}
					mu.Unlock()
				}
			}()
		}
		wg.Wait()
		if len(seen) != 50 {
			t.Fatalf("round %d: %d jobs claimed, want 50", round, len(seen))
		}
		for k, n := range seen {
			if n != 1 {
				t.Fatalf("round %d: %s claimed %d times", round, k, n)
			}
		}
	}
	_ = pages
}
