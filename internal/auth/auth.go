// Package auth wires OIDC (Authorization Code flow) login against an external
// identity provider and keeps the signed-in email in a signed session cookie.
package auth

import (
	"context"
	"encoding/base64"
	"net/http"
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
}

type session struct {
	Email string
}

// New builds an Auth by discovering the provider's OIDC metadata.
func New(ctx context.Context, cfg *config.Config) (*Auth, error) {
	provider, err := oidc.NewProvider(ctx, cfg.LogtoEndpoint)
	if err != nil {
		return nil, err
	}
	sc := securecookie.New([]byte(cfg.SessionSecret), nil)
	sc.MaxAge(int(sessionTTL.Seconds()))
	return &Auth{
		cfg: cfg,
		oauth: oauth2.Config{
			ClientID:     cfg.LogtoAppID,
			ClientSecret: cfg.LogtoAppSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  cfg.AppBaseURL + "/auth/callback",
			Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
		},
		verifier: provider.Verifier(&oidc.Config{ClientID: cfg.LogtoAppID}),
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
// token, and persist the email.
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
	}
	if err := idToken.Claims(&claims); err != nil || claims.Email == "" {
		http.Error(w, "no email claim", http.StatusUnauthorized)
		return
	}
	if enc, err := a.sc.Encode(sessionCookie, session{Email: claims.Email}); err == nil {
		http.SetCookie(w, &http.Cookie{
			Name: sessionCookie, Value: enc, Path: "/", HttpOnly: true,
			Secure: a.cfg.Secure(), SameSite: http.SameSiteLaxMode,
			MaxAge: int(sessionTTL.Seconds()),
		})
	}
	http.Redirect(w, r, "/", http.StatusFound)
}

// Logout clears the session cookie.
func (a *Auth) Logout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1})
	http.Redirect(w, r, "/", http.StatusFound)
}

// Email returns the signed-in email, or "" when there is no valid session.
func (a *Auth) Email(r *http.Request) string {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	var s session
	if err := a.sc.Decode(sessionCookie, c.Value, &s); err != nil {
		return ""
	}
	return s.Email
}
