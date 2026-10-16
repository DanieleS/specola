package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// View tokens let the separate view origin, which has no session cookie,
// serve a page as the user who opened it in the app. A token names the user
// and one page and expires quickly; access is still checked against the
// database on every request, so revoking a share takes effect at once.

const viewTokenTTL = time.Hour

var errBadViewToken = errors.New("invalid or expired view token")

type viewTokens struct{ key []byte }

func newViewTokens(secret string) *viewTokens {
	// A key of its own, so these tokens can't be confused with session cookies.
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte("specola view token v1"))
	return &viewTokens{key: m.Sum(nil)}
}

type viewClaims struct {
	Sub  string `json:"s"`
	Page string `json:"p"`
	Exp  int64  `json:"e"`
}

func (vt *viewTokens) mint(sub, page string, now time.Time) string {
	payload, _ := json.Marshal(viewClaims{Sub: sub, Page: page, Exp: now.Add(viewTokenTTL).Unix()})
	p := base64.RawURLEncoding.EncodeToString(payload)
	return p + "." + base64.RawURLEncoding.EncodeToString(vt.sign(p))
}

// verify returns the sub a token was minted for, if it is authentic, unexpired
// and for this page.
func (vt *viewTokens) verify(token, page string, now time.Time) (string, error) {
	p, sig, ok := strings.Cut(token, ".")
	if !ok {
		return "", errBadViewToken
	}
	got, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || !hmac.Equal(got, vt.sign(p)) {
		return "", errBadViewToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(p)
	if err != nil {
		return "", errBadViewToken
	}
	var c viewClaims
	if err := json.Unmarshal(payload, &c); err != nil || c.Sub == "" || c.Page != page || now.Unix() >= c.Exp {
		return "", errBadViewToken
	}
	return c.Sub, nil
}

func (vt *viewTokens) sign(payload string) []byte {
	m := hmac.New(sha256.New, vt.key)
	m.Write([]byte(payload))
	return m.Sum(nil)
}
