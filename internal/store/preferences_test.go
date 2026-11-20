package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/testdb"
)

func TestPreferences(t *testing.T) {
	st := New(testdb.New(t))
	ctx := context.Background()

	p, err := st.Preferences(ctx, "alice")
	if err != nil || p.Mode != ModeAuto || p.Text != "" || p.StyleRefID != nil || p.UpdatedAt != nil {
		t.Fatalf("defaults = %+v, %v", p, err)
	}

	page, _, err := st.CreatePage(ctx, nil, "Design system", "<p>ds</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	bobs, _, err := st.CreatePage(ctx, nil, "Bob's", "<p>b</p>", "", "bob")
	if err != nil {
		t.Fatal(err)
	}

	p, err = st.SetPreferences(ctx, "alice", PreferencesInput{Mode: "bundle", Text: "  Svelte 5, Tailwind  ", StyleRefID: &page})
	if err != nil {
		t.Fatal(err)
	}
	if p.Mode != ModeBundle || p.Text != "Svelte 5, Tailwind" || p.StyleRef == nil || p.StyleRef.Name != "Design system" || p.StyleRef.Version != 1 {
		t.Fatalf("saved = %+v", p)
	}

	// Private: bob has his own (none).
	if q, _ := st.Preferences(ctx, "bob"); q.Text != "" || q.Mode != ModeAuto {
		t.Fatalf("bob sees %+v", q)
	}

	var invalid *ErrInvalid
	for name, in := range map[string]PreferencesInput{
		"mode":           {Mode: "always"},
		"too long":       {Text: strings.Repeat("é", MaxPreferenceRunes+1)},
		"unseen ref":     {StyleRefID: &bobs},
		"malformed ref":  {StyleRefID: ptr("nope")},
		"nonexisting id": {StyleRefID: ptr("00000000-0000-0000-0000-000000000000")},
	} {
		if _, err := st.SetPreferences(ctx, "alice", in); !errors.As(err, &invalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
	if _, err := st.SetPreferences(ctx, "alice", PreferencesInput{Text: strings.Repeat("é", MaxPreferenceRunes)}); err != nil {
		t.Fatalf("exactly the limit: %v", err)
	}

	// A reference the user can no longer see is kept but doesn't count.
	if _, err := st.SetPreferences(ctx, "alice", PreferencesInput{StyleRefID: &page}); err != nil {
		t.Fatal(err)
	}
	if err := st.Archive(ctx, "alice", KindPage, page); err != nil {
		t.Fatal(err)
	}
	p, _ = st.Preferences(ctx, "alice")
	if p.StyleRefID == nil || p.StyleRef != nil {
		t.Fatalf("archived ref = %+v", p)
	}
	if _, err := st.SetPreferences(ctx, "alice", PreferencesInput{Text: "kept", StyleRefID: &page}); err != nil {
		t.Fatalf("saving with the unchanged ref: %v", err)
	}
	// "" clears it.
	if p, err = st.SetPreferences(ctx, "alice", PreferencesInput{StyleRefID: ptr("")}); err != nil || p.StyleRefID != nil {
		t.Fatalf("cleared = %+v, %v", p, err)
	}
}

func TestFolderConventions(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (sub, email, name) VALUES ('alice', 'alice@example.com', 'Alice'), ('bob', 'bob@example.com', NULL), ('carol', NULL, NULL)`); err != nil {
		t.Fatal(err)
	}

	team, _ := st.CreateFolder(ctx, nil, "Team", "alice")
	finance, _ := st.CreateFolder(ctx, &team, "Finance", "alice")
	reports, _ := st.CreateFolder(ctx, &finance, "Reports", "alice")
	ds, _, _ := st.CreatePage(ctx, &team, "DS", "<p>ds</p>", "", "alice")
	secret, _, _ := st.CreatePage(ctx, nil, "Secret", "<p>s</p>", "", "alice")

	// Bob edits Finance; carol sees only Reports.
	if err := st.Share(ctx, "alice", KindFolder, finance, "bob", RoleEditor); err != nil {
		t.Fatal(err)
	}
	if err := st.Share(ctx, "alice", KindFolder, reports, "carol", RoleViewer); err != nil {
		t.Fatal(err)
	}

	// Only the owner writes them.
	if _, err := st.SetFolderConventions(ctx, "bob", finance, "x", nil); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor writes: %v, want ErrForbidden", err)
	}
	if _, err := st.SetFolderConventions(ctx, "dave", finance, "x", nil); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger writes: %v, want ErrNotFound", err)
	}
	if _, err := st.DeleteFolderConventions(ctx, "bob", finance); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor deletes: %v, want ErrForbidden", err)
	}
	var invalid *ErrInvalid
	if _, err := st.SetFolderConventions(ctx, "alice", finance, strings.Repeat("x", MaxPreferenceRunes+1), nil); !errors.As(err, &invalid) {
		t.Fatalf("too long: %v", err)
	}

	fc, err := st.SetFolderConventions(ctx, "alice", team, "ECharts, EUR", &ds)
	if err != nil {
		t.Fatal(err)
	}
	if fc.Own == nil || fc.Own.Text != "ECharts, EUR" || fc.Own.UpdatedBy != "Alice <alice@example.com>" || fc.Own.Path != "Team" || !fc.CanEdit {
		t.Fatalf("set = %+v", fc)
	}

	// Inherited below, readable by whoever sees the folder.
	fc, err = st.FolderConventions(ctx, "bob", reports)
	if err != nil || fc.Own != nil || fc.CanEdit || fc.Effective == nil || fc.Effective.FolderID != team || fc.Effective.Text != "ECharts, EUR" {
		t.Fatalf("bob on Reports = %+v, %v", fc, err)
	}
	// Bob can't see Team, so its name is hidden; nor can he see the style
	// reference page, whose id isn't told either.
	if fc.Effective.Path != "…" || fc.Effective.FolderName != "…" || fc.Effective.StyleRef != nil || fc.Effective.StyleRefID != nil {
		t.Fatalf("bob's effective = %+v", fc.Effective)
	}
	// Alice, who owns Team, keeps the id of a reference she no longer sees.
	if _, err := pool.Exec(ctx, `UPDATE asset SET archived_at = now() WHERE id = $1`, ds); err != nil {
		t.Fatal(err)
	}
	if fc, _ := st.FolderConventions(ctx, "alice", team); fc.Own == nil || fc.Own.StyleRef != nil || fc.Own.StyleRefID == nil || *fc.Own.StyleRefID != ds {
		t.Fatalf("alice's own with an archived reference = %+v", fc.Own)
	}
	if _, err := pool.Exec(ctx, `UPDATE asset SET archived_at = NULL WHERE id = $1`, ds); err != nil {
		t.Fatal(err)
	}
	if _, err := st.FolderConventions(ctx, "dave", reports); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger reads: %v", err)
	}

	// The nearest wins.
	if _, err := st.SetFolderConventions(ctx, "alice", finance, "React + Tailwind", nil); err != nil {
		t.Fatal(err)
	}
	fc, _ = st.FolderConventions(ctx, "carol", reports)
	if fc.Effective == nil || fc.Effective.FolderID != finance || fc.Effective.Path != "… / …" || fc.Effective.FolderName != "…" || fc.Effective.Text != "React + Tailwind" {
		t.Fatalf("carol on Reports = %+v", fc.Effective)
	}
	fc, _ = st.FolderConventions(ctx, "alice", reports)
	if fc.Effective.Path != "Team / Finance" || !fc.CanEdit {
		t.Fatalf("alice on Reports = %+v", fc)
	}

	// A style reference must be a page the writer can see.
	if _, err := st.SetFolderConventions(ctx, "alice", finance, "x", ptr("00000000-0000-0000-0000-000000000000")); !errors.As(err, &invalid) {
		t.Fatalf("unknown ref: %v", err)
	}

	// The marker on listings.
	items, err := st.Tree(ctx, "alice", &team)
	if err != nil || len(items) != 2 || items[0].Kind != "folder" || !items[0].Conventions {
		t.Fatalf("tree = %+v, %v", items, err)
	}
	items, _ = st.Tree(ctx, "alice", nil)
	if len(items) == 0 || !items[0].Conventions {
		t.Fatalf("root = %+v", items)
	}
	items, _ = st.Tree(ctx, "alice", &finance)
	if len(items) != 1 || items[0].Conventions {
		t.Fatalf("Reports has none of its own: %+v", items)
	}

	// What an agent publishing gets.
	if _, err := st.SetPreferences(ctx, "bob", PreferencesInput{Text: "Vue", StyleRefID: nil}); err != nil {
		t.Fatal(err)
	}
	ac, err := st.AgentConventions(ctx, "bob", &reports)
	if err != nil || ac.Folder == nil || ac.Folder.FolderID != finance || ac.User == nil || ac.User.Text != "Vue" || ac.StyleRef != nil {
		t.Fatalf("bob's agent conventions = %+v, %v", ac, err)
	}
	ac, _ = st.AgentConventions(ctx, "alice", &team)
	if ac.Folder == nil || ac.User != nil || ac.StyleRef == nil || ac.StyleRef.ID != ds || ac.StyleRefFrom != "folder" {
		t.Fatalf("alice's agent conventions = %+v", ac)
	}
	// The user's reference counts where the folder has none.
	if _, err := st.SetPreferences(ctx, "alice", PreferencesInput{StyleRefID: &secret}); err != nil {
		t.Fatal(err)
	}
	ac, _ = st.AgentConventions(ctx, "alice", &finance)
	if ac.StyleRef == nil || ac.StyleRef.ID != secret || ac.StyleRefFrom != "user" {
		t.Fatalf("alice in Finance = %+v", ac.StyleRef)
	}
	// A page in Finance shared with carol on its own: publishing a version,
	// Finance's conventions apply, though she can't see the folder.
	inFinance, _, _ := st.CreatePage(ctx, &finance, "Budget", "<p>b</p>", "", "alice")
	if err := st.Share(ctx, "alice", KindPage, inFinance, "carol", RoleEditor); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AgentConventions(ctx, "carol", &finance); !errors.Is(err, ErrNotFound) {
		t.Fatalf("carol in Finance: %v", err)
	}
	ac, err = st.AgentConventionsForPage(ctx, "carol", inFinance)
	if err != nil || ac.Folder == nil || ac.Folder.FolderID != finance || ac.Folder.Path != "… / …" || ac.At == nil || *ac.At != finance {
		t.Fatalf("carol on Budget = %+v, %v", ac, err)
	}
	if _, err := st.AgentConventionsForPage(ctx, "dave", inFinance); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger on Budget: %v", err)
	}
	ac, _ = st.AgentConventions(ctx, "carol", nil)
	if !ac.Empty() {
		t.Fatalf("carol at her root = %+v", ac)
	}
	if _, err := st.AgentConventions(ctx, "dave", &reports); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger: %v", err)
	}

	// Empty text and no reference remove them; Team's apply again.
	fc, err = st.SetFolderConventions(ctx, "alice", finance, "  ", nil)
	if err != nil || fc.Own != nil || fc.Effective == nil || fc.Effective.FolderID != team {
		t.Fatalf("cleared = %+v, %v", fc, err)
	}
	if fc, err = st.DeleteFolderConventions(ctx, "alice", team); err != nil || fc.Effective != nil {
		t.Fatalf("deleted = %+v, %v", fc, err)
	}
}

func ptr[T any](v T) *T { return &v }
