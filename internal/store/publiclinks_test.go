package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/danieles/specola/internal/testdb"
)

func TestPublicLinkExpiryAndOwnership(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()

	folder, err := st.CreateFolder(ctx, nil, "Team", "alice")
	if err != nil {
		t.Fatal(err)
	}
	page, _, err := st.CreatePage(ctx, &folder, "Plan", "<p>plan</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}

	token, link, err := st.CreatePublicLink(ctx, "alice", page, PublicLinkRequest{TTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	if link.ExpiresAt == nil || time.Until(*link.ExpiresAt) < 59*time.Minute {
		t.Fatalf("expires at %v, want in an hour", link.ExpiresAt)
	}
	if html, err := st.OpenPublicLink(ctx, token); err != nil || html != "<p>plan</p>" {
		t.Fatalf("open = %q, %v", html, err)
	}

	if _, err := pool.Exec(ctx, `UPDATE public_link SET expires_at = now() - interval '1 second' WHERE id = $1::uuid`, link.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := st.OpenPublicLink(ctx, token); !errors.Is(err, ErrLinkExpired) {
		t.Fatalf("expired: %v, want ErrLinkExpired", err)
	}
	links, err := st.PublicLinks(ctx, "alice", page)
	if err != nil || len(links) != 1 || !links[0].Expired || links[0].Views != 1 || links[0].LastUsedAt == nil {
		t.Fatalf("links = %+v, %v", links, err)
	}

	// Only owners make links, and a link works only while its creator owns
	// the page (here, as if it had been made by someone who is now an editor).
	if _, err := pool.Exec(ctx, `INSERT INTO app_user (sub, email) VALUES ('bob', 'bob@example.com')`); err != nil {
		t.Fatal(err)
	}
	if err := st.Share(ctx, "alice", KindFolder, folder, "bob", RoleEditor); err != nil {
		t.Fatal(err)
	}
	if _, _, err := st.CreatePublicLink(ctx, "bob", page, PublicLinkRequest{}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor creates: %v, want ErrForbidden", err)
	}
	token, _, err = st.CreatePublicLink(ctx, "alice", page, PublicLinkRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE public_link SET created_by_sub = 'bob' WHERE secret_hash = $1`, hashToken(token)); err != nil {
		t.Fatal(err)
	}
	if _, err := st.OpenPublicLink(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("creator not an owner: %v, want ErrNotFound", err)
	}

	// Archiving the folder above the page takes its links down.
	token, _, err = st.CreatePublicLink(ctx, "alice", page, PublicLinkRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Archive(ctx, "alice", KindFolder, folder); err != nil {
		t.Fatal(err)
	}
	if _, err := st.OpenPublicLink(ctx, token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("folder archived: %v, want ErrNotFound", err)
	}
}
