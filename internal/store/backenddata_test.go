package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/danieles/specola/internal/testdb"
)

func TestBackendDormancy(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	t0 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	day := func(n int) time.Time { return t0.AddDate(0, 0, n) }

	top, err := st.CreateFolder(ctx, nil, "Top", "alice")
	if err != nil {
		t.Fatal(err)
	}
	sub, err := st.CreateFolder(ctx, &top, "Sub", "alice")
	if err != nil {
		t.Fatal(err)
	}
	page, _, err := st.CreatePage(ctx, &sub, "App", "<p>v1</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	// v1 has a backend, from day 0; the runner holds data for the page.
	exec(`UPDATE asset_version SET backend = '{}', created_at = $2 WHERE asset_id = $1::uuid`, page, day(0))
	exec(`UPDATE asset SET backend_used_at = $2 WHERE id = $1::uuid`, page, day(0))
	other, _, err := st.CreatePage(ctx, nil, "No data", "<p>x</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}

	since := func(want *time.Time) {
		t.Helper()
		var got *time.Time
		if err := pool.QueryRow(ctx, `SELECT backend_dormant_since($1::uuid)`, page).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if (got == nil) != (want == nil) || (got != nil && !got.Equal(*want)) {
			t.Fatalf("dormant since %v, want %v", got, want)
		}
		m, err := st.BackendDormancy(ctx, []string{page, other})
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := m[other]; ok || len(m) > 1 {
			t.Fatalf("dormancy of a page without data: %v", m)
		}
		if g, ok := m[page]; ok != (want != nil) || (ok && !g.Equal(*want)) {
			t.Fatalf("BackendDormancy = %v, want %v", m, want)
		}
		meta, err := st.PageMeta(ctx, "alice", page)
		if errors.Is(err, ErrNotFound) {
			return // archived: no meta to look at
		}
		if err != nil {
			t.Fatal(err)
		}
		if !meta.BackendData || (meta.BackendDormantSince == nil) != (want == nil) {
			t.Fatalf("meta: data %v, dormant since %v", meta.BackendData, meta.BackendDormantSince)
		}
	}
	at := func(t time.Time) *time.Time { return &t }

	// Live: its current version has a backend.
	since(nil)

	// A static version made current on day 3.
	v2, err := st.AddVersion(ctx, page, "<p>static</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE asset_version SET created_at = $3 WHERE asset_id = $1::uuid AND version = $2`, page, v2, day(3))
	since(at(day(3)))

	// The page archived on day 5: the later of the two.
	exec(`UPDATE asset SET archived_at = $2 WHERE id = $1::uuid`, page, day(5))
	since(at(day(5)))
	// And the folder two levels up on day 9: later again.
	exec(`UPDATE folder SET archived_at = $2 WHERE id = $1::uuid`, top, day(9))
	since(at(day(9)))
	// Unarchived, then the backend version restored on day 12: live.
	exec(`UPDATE asset SET archived_at = NULL WHERE id = $1::uuid`, page)
	exec(`UPDATE folder SET archived_at = NULL WHERE id = $1::uuid`, top)
	since(at(day(3)))
	v3, err := st.RestoreVersion(ctx, "alice", page, 1, "")
	if err != nil {
		t.Fatal(err)
	}
	// (A real restore carries the backend over from the version's files;
	// this one has none, so set it as for v1.)
	exec(`UPDATE asset_version SET backend = '{}', created_at = $3 WHERE asset_id = $1::uuid AND version = $2`, page, v3, day(12))
	since(nil)
	// Archived through either folder: the later archive counts, and the
	// backend version's own date doesn't.
	exec(`UPDATE folder SET archived_at = $2 WHERE id = $1::uuid`, sub, day(4))
	exec(`UPDATE folder SET archived_at = $2 WHERE id = $1::uuid`, top, day(2))
	since(at(day(4)))
	// Unarchived: live again.
	exec(`UPDATE folder SET archived_at = NULL`)
	since(nil)

	// No data, no dormancy to tell, whatever the page's state.
	exec(`UPDATE asset SET backend_used_at = NULL, archived_at = $2 WHERE id = $1::uuid`, page, day(20))
	if m, err := st.BackendDormancy(ctx, []string{page}); err != nil || len(m) != 0 {
		t.Fatalf("dormancy without data: %v %v", m, err)
	}
	if m, err := st.BackendDormancy(ctx, nil); err != nil || len(m) != 0 {
		t.Fatalf("no pages: %v %v", m, err)
	}
}

func TestBackendUsedAndPurge(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	usedAt := func(id string) *time.Time {
		t.Helper()
		var at *time.Time
		if err := pool.QueryRow(ctx, `SELECT backend_used_at FROM asset WHERE id = $1::uuid`, id).Scan(&at); err != nil {
			t.Fatal(err)
		}
		return at
	}
	page, _, err := st.CreatePage(ctx, nil, "App", "<p>v1</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	if usedAt(page) != nil {
		t.Fatal("a new page has backend data")
	}
	if err := st.MarkBackendUsed(ctx, page); err != nil || usedAt(page) == nil {
		t.Fatalf("mark: %v", err)
	}
	// Within the hour the mark stays as it is; past it, it moves.
	recent := time.Now().Add(-10 * time.Minute).UTC().Truncate(time.Microsecond)
	if _, err := pool.Exec(ctx, `UPDATE asset SET backend_used_at = $2 WHERE id = $1::uuid`, page, recent); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkBackendUsed(ctx, page); err != nil || !usedAt(page).Equal(recent) {
		t.Fatalf("mark within the hour moved: %v %v", usedAt(page), err)
	}
	old := time.Now().Add(-2 * time.Hour)
	if _, err := pool.Exec(ctx, `UPDATE asset SET backend_used_at = $2 WHERE id = $1::uuid`, page, old); err != nil {
		t.Fatal(err)
	}
	if err := st.MarkBackendUsed(ctx, page); err != nil || !usedAt(page).After(old.Add(time.Hour)) {
		t.Fatalf("stale mark not moved: %v %v", usedAt(page), err)
	}
	if err := st.MarkBackendUsed(ctx, "nope"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("mark of a bad id: %v", err)
	}

	// The page is static from the start: dormant since its version.
	var created time.Time
	if err := pool.QueryRow(ctx, `SELECT created_at FROM asset_version WHERE asset_id = $1::uuid`, page).Scan(&created); err != nil {
		t.Fatal(err)
	}
	due := func(before time.Time, want ...string) {
		t.Helper()
		ids, err := st.BackendPurgeDue(ctx, before)
		if err != nil {
			t.Fatal(err)
		}
		if len(ids) != len(want) || (len(want) == 1 && ids[0] != want[0]) {
			t.Fatalf("due before %v: %v, want %v", before, ids, want)
		}
	}
	due(created)
	due(created.Add(time.Second), page)

	calls := 0
	purge := func(err error) func(context.Context) error {
		return func(context.Context) error { calls++; return err }
	}
	// Not due yet: nothing is asked.
	if ran, err := st.PurgeBackendData(ctx, page, created, purge(nil)); ran || err != nil || calls != 0 {
		t.Fatalf("early purge: %v %v %d", ran, err, calls)
	}
	// The runner fails: the mark stays, for the next round.
	boom := errors.New("runner down")
	if ran, err := st.PurgeBackendData(ctx, page, created.Add(time.Second), purge(boom)); ran || !errors.Is(err, boom) || usedAt(page) == nil {
		t.Fatalf("failed purge: %v %v", ran, err)
	}
	if ran, err := st.PurgeBackendData(ctx, page, created.Add(time.Second), purge(nil)); !ran || err != nil || usedAt(page) != nil {
		t.Fatalf("purge: %v %v %v", ran, err, usedAt(page))
	}
	due(created.Add(time.Second))
	// Once purged, nothing more to do.
	calls = 0
	if ran, err := st.PurgeBackendData(ctx, page, created.Add(time.Second), purge(nil)); ran || err != nil || calls != 0 {
		t.Fatalf("second purge: %v %v %d", ran, err, calls)
	}
	if ran, err := st.PurgeBackendData(ctx, "nope", created, purge(nil)); ran || err != nil {
		t.Fatalf("purge of a bad id: %v %v", ran, err)
	}
}
