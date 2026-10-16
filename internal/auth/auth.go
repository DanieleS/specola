// Package auth wires OIDC (Authorization Code flow) login against an external
// identity provider and keeps the signed-in identity in a signed session cookie.
package auth

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/url"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/danieles/specola/internal/config"
	"github.com/gorilla/securecookie"
	"golang.org/x/oauth2"
)

const (
	sessionCookie = "specola_session"
	stateCookie   = "specola_oidc_state"
	sessionTTL    = 7 * 24 * time.Hour
)

type Auth struct {
	cfg      *config.Config
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	sc       *securecookie.SecureCookie
	// endSession is the provider's RP-initiated logout URL, if it advertises one.
	endSession string

	// OnLogin, when set, runs after a successful login and before the session
	// cookie is issued; an error aborts the login.
	OnLogin func(ctx context.Context, id Identity, name string) error
}

// Identity is who a request acts as. Sub is the stable OIDC subject and the key
// everything is owned by; Email is informational and may be empty.
type Identity struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
}

type session struct {
	Sub   string
	Email string
}

// New builds an Auth by discovering the provider's OIDC metadata.
func New(ctx context.Context, cfg *config.Config) (*Auth, error) {
	provider, err := oidc.NewProvider(ctx, cfg.OIDCIssuer)
	if err != nil {
		return nil, err
	}
	var meta struct {
		EndSession string `json:"end_session_endpoint"`
	}
	_ = provider.Claims(&meta)

	sc := securecookie.New([]byte(cfg.SessionSecret), nil)
	sc.MaxAge(int(sessionTTL.Seconds()))
	return &Auth{
		endSession: meta.EndSession,
		cfg:        cfg,
		oauth: oauth2.Config{
			ClientID:     cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  cfg.AppBaseURL + "/auth/callback",
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		},
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID}),
		sc:       sc,
	}, nil
}

// Login starts the flow: set a state cookie and redirect to the provider.
func (a *Auth) Login(w http.ResponseWriter, r *http.Request) {
	state := base64.RawURLEncoding.EncodeToString(securecookie.GenerateRandomKey(16))
	http.SetCookie(w, &http.Cookie{
		Name: stateCookie, Value: state, Path: "/", HttpOnly: true,
		Secure: a.cfg.Secure(), SameSite: http.SameSiteLaxMode, MaxAge: 600,
	})
	http.Redirect(w, r, a.oauth.AuthCodeURL(state), http.StatusFound)
}

// Callback completes the flow: verify state, exchange the code, verify the ID
// token, and persist the subject and email.
func (a *Auth) Callback(w http.ResponseWriter, r *http.Request) {
	st, err := r.Cookie(stateCookie)
	if err != nil || r.URL.Query().Get("state") == "" || r.URL.Query().Get("state") != st.Value {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}
	tok, err := a.oauth.Exchange(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok {
		http.Error(w, "no id_token in response", http.StatusBadGateway)
		return
	}
	idToken, err := a.verifier.Verify(r.Context(), rawID)
	if err != nil {
		http.Error(w, "id_token verification failed", http.StatusUnauthorized)
		return
	}
	var claims struct {
		Email string `json:"email"`
		Name  string `json:"name"`
	}
	if err := idToken.Claims(&claims); err != nil || idToken.Subject == "" {
		http.Error(w, "no subject in id_token", http.StatusUnauthorized)
		return
	}
	id := Identity{Sub: idToken.Subject, Email: claims.Email}
	if a.OnLogin != nil {
		if err := a.OnLogin(r.Context(), id, claims.Name); err != nil {
			http.Error(w, "could not record login", http.StatusInternalServerError)
			return
		}
	}
	if enc, err := a.sc.Encode(sessionCookie, session{Sub: id.Sub, Email: id.Email}); err == nil {
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookie, Value: enc, Path: "/", HttpOnly: true,
			Secure: a.cfg.Secure(), SameSite: http.SameSiteLaxMode,
			MaxAge: int(sessionTTL.Seconds()),
		})
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

// Logout clears the session cookie and, when the provider supports it, ends the
// provider session too — otherwise the next visit would silently log back in.
func (a *Auth) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
	if a.endSession == "" {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	q := url.Values{
		"client_id":                {a.cfg.OIDCClientID},
		"post_logout_redirect_uri": {a.cfg.AppBaseURL + "/"},
	}
	http.Redirect(w, r, a.endSession+"?"+q.Encode(), http.StatusFound)
}

// Identity returns the signed-in identity, or the zero value when there is no
// valid session. Sessions issued before users were keyed by sub carry no Sub
// and count as signed out.
func (a *Auth) Identity(r *http.Request) Identity {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return Identity{}
	}
	var s session
	if err := a.sc.Decode(sessionCookie, c.Value, &s); err != nil || s.Sub == "" {
		return Identity{}
	}
	return Identity{Sub: s.Sub, Email: s.Email}
}
