package store

import (
	"context"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/testdb"
)

func TestSearch(t *testing.T) {
	st := New(testdb.New(t))
	ctx := context.Background()

	page := func(name, html, sub string) string {
		t.Helper()
		id, _, err := st.CreatePage(ctx, nil, name, html, sub)
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	search := func(sub, q string) []SearchResult {
		t.Helper()
		res, err := st.Search(ctx, sub, q, 0)
		if err != nil {
			t.Fatalf("search %q: %v", q, err)
		}
		return res
	}
	ids := func(res []SearchResult) []string {
		out := []string{}
		for _, r := range res {
			out = append(out, r.ID)
		}
		return out
	}

	attention := page("Attention explained", `<html><head><style>.zebra{}</style></head>
		<body><h1>Transformers</h1><p>Queries, keys and values.</p>
		<script>const giraffe = 1;</script></body></html>`, "alice")
	budget := page("Budget 2027", `<p>Spend on transformers hardware.</p>`, "alice")

	t.Run("matches title and body", func(t *testing.T) {
		if got := ids(search("alice", "attention")); len(got) != 1 || got[0] != attention {
			t.Fatalf("attention: %v", got)
		}
		got := search("alice", "transformers")
		if len(got) != 2 {
			t.Fatalf("transformers: %v", ids(got))
		}
		if !strings.Contains(got[0].Snippet, "<mark>") {
			t.Fatalf("no highlight: %q", got[0].Snippet)
		}
		if res := ids(search("alice", "transformers -budget")); len(res) != 1 || res[0] != attention {
			t.Fatalf("exclusion: %v", res)
		}
	})

	t.Run("script and style aren't text", func(t *testing.T) {
		for _, q := range []string{"giraffe", "zebra"} {
			if got := search("alice", q); len(got) != 0 {
				t.Fatalf("%s matched %v", q, ids(got))
			}
		}
	})

	t.Run("new version replaces the indexed text", func(t *testing.T) {
		if _, err := st.AddVersion(ctx, budget, "<p>Revised forecast.</p>", "alice"); err != nil {
			t.Fatal(err)
		}
		if got := ids(search("alice", "hardware")); len(got) != 0 {
			t.Fatalf("old text still matches: %v", got)
		}
		if got := ids(search("alice", "forecast")); len(got) != 1 || got[0] != budget {
			t.Fatalf("new text: %v", got)
		}
	})

	t.Run("only what the caller can see", func(t *testing.T) {
		if got := search("bob", "transformers"); len(got) != 0 {
			t.Fatalf("bob sees %v", ids(got))
		}
		if _, err := st.pool.Exec(ctx, `INSERT INTO app_user (sub, email) VALUES ('bob', 'bob@example.com')`); err != nil {
			t.Fatal(err)
		}
		if err := st.Share(ctx, "alice", KindPage, attention, "bob", RoleViewer); err != nil {
			t.Fatal(err)
		}
		got := search("bob", "transformers")
		if len(got) != 1 || got[0].ID != attention || got[0].Role != "viewer" {
			t.Fatalf("bob after share: %+v", got)
		}
	})

	t.Run("snippets are escaped", func(t *testing.T) {
		page("Tricky", `<p>&lt;img src=x onerror=alert(1)&gt; needle</p>`, "alice")
		got := search("alice", "needle")
		if len(got) != 1 {
			t.Fatalf("needle: %v", ids(got))
		}
		s := got[0].Snippet
		bare := strings.NewReplacer("<mark>", "", "</mark>", "").Replace(s)
		if strings.ContainsAny(bare, "<>") || !strings.Contains(s, "&gt;") || !strings.Contains(s, "<mark>needle</mark>") {
			t.Fatalf("snippet = %q", s)
		}
	})

	t.Run("empty query", func(t *testing.T) {
		if got := search("alice", "   "); len(got) != 0 {
			t.Fatalf("empty query matched %v", ids(got))
		}
	})
}
