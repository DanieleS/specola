package store

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danieles/specola/internal/backend"

	"github.com/jackc/pgx/v5"
)

// Page secrets (docs/page-backends.md, "Secrets"): values a page's owners
// set for the names its backend declares (API keys…), sent to the runner
// with every call and scheduled run of the current version, and never read
// back by anyone through the UI, the API or MCP.
//
// They are encrypted with AES-256-GCM under SPECOLA_SECRETS_KEY, with a
// fresh nonce per write. The associated data binds a ciphertext to its page
// and name (the page's canonical id, a 0 byte, the name), so a row copied to
// another page or renamed in the database doesn't decrypt.

const (
	// MaxSecretBytes bounds a secret's value: an API key, a token, a small
	// JSON credential; not a file.
	MaxSecretBytes = 8 << 10
	// SecretsKeyBytes is the size of SPECOLA_SECRETS_KEY.
	SecretsKeyBytes = 32
)

// secretName is a secret's name, as a manifest declares it
// (backend.ParseManifest checks the same).
var secretName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

// SecretInfo is what may be told about a page's secret: never its value.
// Declared: the current version's manifest names it; Set: it has a value.
type SecretInfo struct {
	Name      string     `json:"name"`
	Declared  bool       `json:"declared"`
	Set       bool       `json:"set"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
	UpdatedBy string     `json:"updatedBy,omitempty"`
}

// secretAD is the associated data of a page's secret.
func secretAD(assetID, name string) []byte {
	return append(append([]byte(assetID), 0), name...)
}

func secretsCipher(key []byte) (cipher.AEAD, error) {
	if len(key) != SecretsKeyBytes {
		return nil, fmt.Errorf("the secrets key must be %d bytes, not %d", SecretsKeyBytes, len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// sealSecret encrypts a value for page assetID (canonical) and name.
func sealSecret(key []byte, assetID, name, value string) (ciphertext, nonce []byte, err error) {
	aead, err := secretsCipher(key)
	if err != nil {
		return nil, nil, err
	}
	nonce = make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return aead.Seal(nil, nonce, []byte(value), secretAD(assetID, name)), nonce, nil
}

// openSecret decrypts what sealSecret made for the same page and name.
func openSecret(key []byte, assetID, name string, ciphertext, nonce []byte) (string, error) {
	aead, err := secretsCipher(key)
	if err != nil {
		return "", err
	}
	if len(nonce) != aead.NonceSize() {
		return "", fmt.Errorf("secret %s: bad nonce", name)
	}
	plain, err := aead.Open(nil, nonce, ciphertext, secretAD(assetID, name))
	if err != nil {
		// A changed key, or a row that was tampered with or moved.
		return "", fmt.Errorf("secret %s of page %s doesn't decrypt (was SPECOLA_SECRETS_KEY changed?): %w", name, assetID, err)
	}
	return string(plain), nil
}

// CheckSecret checks a secret's name and value as PUT takes them.
func CheckSecret(name, value string) error {
	if !secretName.MatchString(name) {
		return &ErrInvalid{"a secret's name is an upper-case letter then up to 63 upper-case letters, digits or _"}
	}
	if len(value) == 0 || len(value) > MaxSecretBytes {
		return &ErrInvalid{fmt.Sprintf("a secret's value is 1 byte to %d KiB", MaxSecretBytes>>10)}
	}
	if !utf8.ValidString(value) {
		return &ErrInvalid{"a secret's value must be UTF-8 text"}
	}
	return nil
}

// canonicalPage returns page id's canonical spelling, checking that sub has
// at least min on it. Secrets are bound to that spelling, whatever the URL
// said.
func canonicalPage(ctx context.Context, q querier, sub, id string, min Role) (string, error) {
	if err := checkPage(ctx, q, id, sub, min); err != nil {
		return "", err
	}
	var canon string
	err := q.QueryRow(ctx, `SELECT id::text FROM asset WHERE id = $1::uuid`, id).Scan(&canon)
	return canon, err
}

// declaredSecrets returns the secrets the current version of page id
// declares (none without a backend).
func declaredSecrets(ctx context.Context, q querier, id string) ([]string, error) {
	var raw []byte
	err := q.QueryRow(ctx, `
		SELECT cur.backend FROM asset a
		JOIN asset_version cur ON cur.asset_id = a.id AND cur.version = a.current_version
		WHERE a.id = $1::uuid`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return nil, ErrNotFound
	}
	if err != nil || raw == nil {
		return nil, err
	}
	var m backend.Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, err
	}
	return m.Secrets, nil
}

// ListPageSecrets lists a page's secrets for its owners and editors: every
// name the current version declares, and any set but no longer declared,
// sorted by name.
func (s *Store) ListPageSecrets(ctx context.Context, sub, pageID string) ([]SecretInfo, error) {
	id, err := canonicalPage(ctx, s.pool, sub, pageID, RoleEditor)
	if err != nil {
		return nil, err
	}
	declared, err := declaredSecrets(ctx, s.pool, id)
	if err != nil {
		return nil, err
	}
	byName := map[string]*SecretInfo{}
	for _, n := range declared {
		byName[n] = &SecretInfo{Name: n, Declared: true}
	}
	rows, err := s.pool.Query(ctx, `SELECT name, updated_at, updated_by FROM page_secret WHERE asset_id = $1::uuid`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			name, by string
			at       time.Time
		)
		if err := rows.Scan(&name, &at, &by); err != nil {
			return nil, err
		}
		info := byName[name]
		if info == nil {
			info = &SecretInfo{Name: name}
			byName[name] = info
		}
		info.Set, info.UpdatedAt, info.UpdatedBy = true, &at, by
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]SecretInfo, 0, len(byName))
	for _, info := range byName {
		out = append(out, *info)
	}
	slices.SortFunc(out, func(a, b SecretInfo) int { return strings.Compare(a.Name, b.Name) })
	return out, nil
}

// SetPageSecret sets a secret of a page sub owns. The name need not be
// declared yet: an owner may set it ahead of the version that will.
func (s *Store) SetPageSecret(ctx context.Context, sub, pageID, name, value string, key []byte) error {
	if err := CheckSecret(name, value); err != nil {
		return err
	}
	id, err := canonicalPage(ctx, s.pool, sub, pageID, RoleOwner)
	if err != nil {
		return err
	}
	ciphertext, nonce, err := sealSecret(key, id, name, value)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO page_secret (asset_id, name, ciphertext, nonce, updated_by, updated_at)
		VALUES ($1::uuid, $2, $3, $4, $5, now())
		ON CONFLICT (asset_id, name) DO UPDATE SET
		  ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
		  updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
		id, name, ciphertext, nonce, sub)
	return err
}

// DeletePageSecret removes a secret of a page sub owns; removing one that
// isn't set is not an error.
func (s *Store) DeletePageSecret(ctx context.Context, sub, pageID, name string) error {
	if !secretName.MatchString(name) {
		return &ErrInvalid{"a secret's name is an upper-case letter then up to 63 upper-case letters, digits or _"}
	}
	id, err := canonicalPage(ctx, s.pool, sub, pageID, RoleOwner)
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx, `DELETE FROM page_secret WHERE asset_id = $1::uuid AND name = $2`, id, name)
	return err
}

// PageSecretValues decrypts those of names that page pageID has set, for a
// call to its backend. It doesn't check access: the caller has. A value
// that doesn't decrypt is an error, not a missing secret, so that a changed
// key is noticed rather than silently running code without its keys.
func (s *Store) PageSecretValues(ctx context.Context, pageID string, names []string, key []byte) (map[string]string, error) {
	out := map[string]string{}
	if len(names) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT asset_id::text, name, ciphertext, nonce FROM page_secret
		WHERE asset_id = $1::uuid AND name = ANY($2::text[])`, pageID, names)
	if isInvalidText(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var (
			id, name          string
			ciphertext, nonce []byte
		)
		if err := rows.Scan(&id, &name, &ciphertext, &nonce); err != nil {
			return nil, err
		}
		v, err := openSecret(key, id, name, ciphertext, nonce)
		if err != nil {
			return nil, err
		}
		out[name] = v
	}
	if err := rows.Err(); err != nil {
		if isInvalidText(err) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

// MissingPageSecrets returns the names the current version of page pageID
// declares and has no value for, in the manifest's order. It doesn't check
// access: the page meta it goes with is for owners and editors only.
func (s *Store) MissingPageSecrets(ctx context.Context, pageID string) ([]string, error) {
	declared, err := declaredSecrets(ctx, s.pool, pageID)
	if err != nil {
		return nil, err
	}
	missing := []string{}
	if len(declared) == 0 {
		return missing, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT name FROM page_secret WHERE asset_id = $1::uuid AND name = ANY($2::text[])`, pageID, declared)
	if err != nil {
		return nil, err
	}
	set, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, err
	}
	for _, n := range declared {
		if !slices.Contains(set, n) {
			missing = append(missing, n)
		}
	}
	return missing, nil
}
