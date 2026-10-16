package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/danieles/specola/internal/testdb"
)

func TestUploadGrants(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()

	mint := func(req GrantRequest) string {
		t.Helper()
		token, expires, err := st.MintGrant(ctx, req, 10*time.Minute)
		if err != nil {
			t.Fatalf("mint %+v: %v", req, err)
		}
		if d := time.Until(expires); d < 9*time.Minute || d > 11*time.Minute {
			t.Fatalf("expires in %v, want ~10m", d)
		}
		return token
	}

	folder, err := st.CreateFolder(ctx, nil, "Reports", "alice")
	if err != nil {
		t.Fatal(err)
	}

	t.Run("new page, single use", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "Big", FolderID: &folder})
		id, version, err := st.RedeemUpload(ctx, token, "<p>big</p>")
		if err != nil || version != 1 {
			t.Fatalf("redeem = %q, %d, %v", id, version, err)
		}
		meta, err := st.PageMeta(ctx, "alice", id)
		if err != nil || meta.Name != "Big" || meta.FolderID == nil || *meta.FolderID != folder {
			t.Fatalf("page meta = %+v, %v", meta, err)
		}
		if _, _, err := st.RedeemUpload(ctx, token, "<p>again</p>"); !errors.Is(err, ErrGrantGone) {
			t.Fatalf("second use: %v, want ErrGrantGone", err)
		}
	})

	page, _, err := st.CreatePage(ctx, nil, "Page", "<p>v1</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}

	t.Run("new version", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: page})
		id, version, err := st.RedeemUpload(ctx, token, "<p>v2</p>")
		if err != nil || id != page || version != 2 {
			t.Fatalf("redeem = %q, %d, %v", id, version, err)
		}
		if html, _ := st.CurrentContent(ctx, "alice", page); html != "<p>v2</p>" {
			t.Fatalf("content = %q", html)
		}
	})

	t.Run("expired", func(t *testing.T) {
		token := mint(GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: page})
		if _, err := pool.Exec(ctx, `UPDATE asset_grant SET expires_at = now() - interval '1 second' WHERE secret_hash = $1`, hashToken(token)); err != nil {
			t.Fatal(err)
		}
		if _, _, err := st.RedeemUpload(ctx, token, "<p>x</p>"); !errors.Is(err, ErrGrantGone) {
			t.Fatalf("expired: %v, want ErrGrantGone", err)
		}
	})

	t.Run("wrong kind", func(t *testing.T) {
		token := "download-token"
		if _, err := pool.Exec(ctx, `
			INSERT INTO asset_grant (kind, secret_hash, asset_id, created_by_sub, expires_at)
			VALUES ('DOWNLOAD', $1, $2::uuid, 'alice', now() + interval '10 minutes')`, hashToken(token), page); err != nil {
			t.Fatal(err)
		}
		if _, _, err := st.RedeemUpload(ctx, token, "<p>x</p>"); !errors.Is(err, ErrGrantKind) {
			t.Fatalf("download grant: %v, want ErrGrantKind", err)
		}
	})

	t.Run("access lost before redeem", func(t *testing.T) {
		victim, _, err := st.CreatePage(ctx, nil, "Victim", "<p>v1</p>", "", "alice")
		if err != nil {
			t.Fatal(err)
		}
		vToken := mint(GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: victim})
		gone, err := st.CreateFolder(ctx, nil, "Gone", "alice")
		if err != nil {
			t.Fatal(err)
		}
		nToken := mint(GrantRequest{Kind: GrantUploadNew, Sub: "alice", Name: "Late", FolderID: &gone})

		if _, err := pool.Exec(ctx, `UPDATE asset SET archived_at = now() WHERE id = $1::uuid`, victim); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `UPDATE folder SET archived_at = now() WHERE id = $1::uuid`, gone); err != nil {
			t.Fatal(err)
		}
		if _, _, err := st.RedeemUpload(ctx, vToken, "<p>x</p>"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("archived page: %v, want ErrNotFound", err)
		}
		if _, _, err := st.RedeemUpload(ctx, nToken, "<p>x</p>"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("archived folder: %v, want ErrNotFound", err)
		}
	})

	t.Run("unknown token", func(t *testing.T) {
		if _, _, err := st.RedeemUpload(ctx, "nope", "<p>x</p>"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("unknown: %v, want ErrNotFound", err)
		}
	})

	t.Run("can't mint for someone else's items", func(t *testing.T) {
		if _, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadVersion, Sub: "bob", AssetID: page}, time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatalf("bob version grant: %v, want ErrNotFound", err)
		}
		if _, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadNew, Sub: "bob", Name: "x", FolderID: &folder}, time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatalf("bob new grant in alice's folder: %v, want ErrNotFound", err)
		}
	})

	t.Run("sweep", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE asset_grant SET expires_at = now() - interval '2 days'`); err != nil {
			t.Fatal(err)
		}
		n, err := st.SweepGrants(ctx, 24*time.Hour)
		if err != nil || n == 0 {
			t.Fatalf("sweep = %d, %v", n, err)
		}
		var left int
		_ = pool.QueryRow(ctx, `SELECT count(*) FROM asset_grant`).Scan(&left)
		if left != 0 {
			t.Fatalf("%d grants left after sweep", left)
		}
	})
}
