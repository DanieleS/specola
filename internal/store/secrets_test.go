package store

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/testdb"
)

func TestSecretCrypto(t *testing.T) {
	key := make([]byte, 32)
	key[0] = 7
	const page, other = "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
	ct, nonce, err := sealSecret(key, page, "API_KEY", "sk-123")
	if err != nil {
		t.Fatal(err)
	}
	if len(nonce) != 12 || strings.Contains(string(ct), "sk-123") {
		t.Fatalf("nonce %d bytes, ciphertext %q", len(nonce), ct)
	}
	if v, err := openSecret(key, page, "API_KEY", ct, nonce); err != nil || v != "sk-123" {
		t.Fatalf("round trip: %q %v", v, err)
	}
	// A fresh nonce every time: the same value never encrypts the same.
	ct2, nonce2, _ := sealSecret(key, page, "API_KEY", "sk-123")
	if string(nonce2) == string(nonce) || string(ct2) == string(ct) {
		t.Fatal("nonce reused")
	}
	// Moved to another page or name, or tampered with, or under another key:
	// it doesn't decrypt.
	if _, err := openSecret(key, other, "API_KEY", ct, nonce); err == nil {
		t.Fatal("decrypted on another page")
	}
	if _, err := openSecret(key, page, "OTHER", ct, nonce); err == nil {
		t.Fatal("decrypted under another name")
	}
	bad := append([]byte(nil), ct...)
	bad[0] ^= 1
	if _, err := openSecret(key, page, "API_KEY", bad, nonce); err == nil {
		t.Fatal("tampered ciphertext decrypted")
	}
	key2 := make([]byte, 32)
	if _, err := openSecret(key2, page, "API_KEY", ct, nonce); err == nil {
		t.Fatal("decrypted with another key")
	}
	if _, _, err := sealSecret(make([]byte, 16), page, "A", "v"); err == nil {
		t.Fatal("a 16-byte key was accepted")
	}
}

func TestCheckSecret(t *testing.T) {
	for _, ok := range [][2]string{{"A", "v"}, {"OPENAI_API_KEY", "x"}, {"K" + strings.Repeat("9", 63), strings.Repeat("é", 4096)}} {
		if err := CheckSecret(ok[0], ok[1]); err != nil {
			t.Errorf("%q: %v", ok[0], err)
		}
	}
	for _, bad := range [][2]string{
		{"a", "v"}, {"_A", "v"}, {"1A", "v"}, {"A-B", "v"}, {"K" + strings.Repeat("9", 64), "v"}, {"", "v"},
		{"A", ""}, {"A", strings.Repeat("x", 8193)}, {"A", "\xff"},
	} {
		var inv *ErrInvalid
		if err := CheckSecret(bad[0], bad[1]); !errors.As(err, &inv) {
			t.Errorf("%q=%.10q: %v", bad[0], bad[1], err)
		}
	}
}

func TestPageSecrets(t *testing.T) {
	pool := testdb.New(t)
	st := New(pool)
	ctx := context.Background()
	key := make([]byte, 32)
	key[31] = 1

	page, _, err := st.CreatePage(ctx, nil, "Plain", "<p>x</p>", "", "alice")
	if err != nil {
		t.Fatal(err)
	}
	for _, sh := range []struct {
		sub  string
		role Role
	}{{"ed", RoleEditor}, {"viewer", RoleViewer}} {
		if err := st.Share(ctx, "alice", KindPage, page, sh.sub, sh.role); err != nil {
			t.Fatal(err)
		}
	}

	// A page without a backend has no declared secrets, but an owner may set
	// one ahead of the version that will declare it.
	if list, err := st.ListPageSecrets(ctx, "alice", page); err != nil || len(list) != 0 {
		t.Fatalf("empty list: %+v %v", list, err)
	}
	if err := st.SetPageSecret(ctx, "alice", page, "OPENAI_API_KEY", "sk-early", key); err != nil {
		t.Fatal(err)
	}

	// A backend version declaring two, one of which is set already.
	token, _, err := st.MintGrant(ctx, GrantRequest{Kind: GrantUploadVersion, Sub: "alice", AssetID: page, Bundle: true}, BundleGrantTTL)
	if err != nil {
		t.Fatal(err)
	}
	app := bundle{
		"index.html":                `<p>app</p>`,
		".specola/backend.json":     `{"version":1,"secrets":["STRIPE_KEY","OPENAI_API_KEY"]}`,
		".specola/server/index.mjs": `export default {}`,
	}
	uploadBundle(t, st, token, app, "")
	if missing, err := st.MissingPageSecrets(ctx, page); err != nil || strings.Join(missing, ",") != "STRIPE_KEY" {
		t.Fatalf("missing = %v %v", missing, err)
	}

	// Roles: owners set and delete; editors list; viewers nothing; others
	// don't see the page.
	if err := st.SetPageSecret(ctx, "ed", page, "STRIPE_KEY", "x", key); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor set: %v", err)
	}
	if err := st.DeletePageSecret(ctx, "ed", page, "OPENAI_API_KEY"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("editor delete: %v", err)
	}
	if _, err := st.ListPageSecrets(ctx, "viewer", page); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer list: %v", err)
	}
	if _, err := st.ListPageSecrets(ctx, "mallory", page); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger list: %v", err)
	}
	if err := st.SetPageSecret(ctx, "mallory", page, "STRIPE_KEY", "x", key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("stranger set: %v", err)
	}
	if _, err := st.ListPageSecrets(ctx, "alice", "not-a-uuid"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bad id: %v", err)
	}

	// Set through another spelling of the page's id: bound to the page.
	if err := st.SetPageSecret(ctx, "alice", strings.ToUpper(page), "STRIPE_KEY", "sk_live_1", key); err != nil {
		t.Fatal(err)
	}
	if err := st.SetPageSecret(ctx, "alice", page, "STRIPE_KEY", "sk_live_2", key); err != nil {
		t.Fatal(err)
	}
	if err := st.SetPageSecret(ctx, "alice", page, "LEFTOVER", "old", key); err != nil {
		t.Fatal(err)
	}
	list, err := st.ListPageSecrets(ctx, "ed", page)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, s := range list {
		got = append(got, s.Name)
		if s.Set != (s.UpdatedAt != nil) || (s.Set && s.UpdatedBy != "alice") {
			t.Errorf("%+v", s)
		}
	}
	if strings.Join(got, ",") != "LEFTOVER,OPENAI_API_KEY,STRIPE_KEY" ||
		list[0].Declared || !list[0].Set || !list[1].Declared || !list[2].Declared || !list[2].Set {
		t.Fatalf("list = %+v", list)
	}
	if missing, _ := st.MissingPageSecrets(ctx, page); len(missing) != 0 {
		t.Fatalf("missing = %v", missing)
	}

	// Values: only the names asked for and set, decrypted.
	vals, err := st.PageSecretValues(ctx, page, []string{"STRIPE_KEY", "OPENAI_API_KEY", "UNSET"}, key)
	if err != nil || len(vals) != 2 || vals["STRIPE_KEY"] != "sk_live_2" || vals["OPENAI_API_KEY"] != "sk-early" {
		t.Fatalf("values = %v %v", vals, err)
	}
	if vals, err := st.PageSecretValues(ctx, page, nil, key); err != nil || len(vals) != 0 {
		t.Fatalf("no names: %v %v", vals, err)
	}
	// Stored encrypted.
	var raw []byte
	if err := pool.QueryRow(ctx, `SELECT ciphertext FROM page_secret WHERE name = 'STRIPE_KEY'`).Scan(&raw); err != nil ||
		strings.Contains(string(raw), "sk_live") {
		t.Fatalf("stored %q %v", raw, err)
	}
	// A different key: an error, never a silently missing secret.
	if _, err := st.PageSecretValues(ctx, page, []string{"STRIPE_KEY"}, make([]byte, 32)); err == nil {
		t.Fatal("decrypted with the wrong key")
	}

	// A ciphertext moved to another page doesn't decrypt there.
	other, _, _ := st.CreatePage(ctx, nil, "Other", "<p>y</p>", "", "alice")
	if _, err := pool.Exec(ctx, `
		INSERT INTO page_secret (asset_id, name, ciphertext, nonce, updated_by)
		SELECT $1::uuid, name, ciphertext, nonce, updated_by FROM page_secret WHERE asset_id = $2::uuid AND name = 'STRIPE_KEY'`,
		other, page); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PageSecretValues(ctx, other, []string{"STRIPE_KEY"}, key); err == nil {
		t.Fatal("a moved ciphertext decrypted")
	}
	// So does one renamed.
	if _, err := pool.Exec(ctx, `DELETE FROM page_secret WHERE asset_id = $1::uuid AND name = 'OPENAI_API_KEY'`, page); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE page_secret SET name = 'OPENAI_API_KEY' WHERE asset_id = $1::uuid AND name = 'LEFTOVER'`, page); err != nil {
		t.Fatal(err)
	}
	if _, err := st.PageSecretValues(ctx, page, []string{"OPENAI_API_KEY"}, key); err == nil {
		t.Fatal("a renamed ciphertext decrypted")
	}
	if err := st.DeletePageSecret(ctx, "alice", page, "OPENAI_API_KEY"); err != nil {
		t.Fatal(err)
	}

	// Delete: also when unset.
	if err := st.DeletePageSecret(ctx, "alice", page, "STRIPE_KEY"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeletePageSecret(ctx, "alice", page, "STRIPE_KEY"); err != nil {
		t.Fatalf("delete twice: %v", err)
	}
	if err := st.DeletePageSecret(ctx, "alice", page, "bad name"); err == nil {
		t.Fatal("bad name deleted")
	}
	if missing, _ := st.MissingPageSecrets(ctx, page); strings.Join(missing, ",") != "STRIPE_KEY,OPENAI_API_KEY" {
		t.Fatalf("missing after delete = %v", missing)
	}
}
