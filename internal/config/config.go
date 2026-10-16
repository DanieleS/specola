// Package config loads Specola's runtime configuration from the environment.
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	ListenAddr  string
	DatabaseURL string
	// AppBaseURL is the public origin, e.g. https://specola.example.com.
	// Used to build the OIDC redirect URL and to decide cookie Secure flags.
	AppBaseURL    string
	SessionSecret string

	// Logto OIDC. LogtoEndpoint is the issuer URL, e.g.
	// https://auth.example.com/oidc
	LogtoEndpoint  string
	LogtoAppID     string
	LogtoAppSecret string

	// TrustedUserHeader, when set, makes Specola read the caller's identity from
	// this request header (e.g. X-Forwarded-User) instead of running its own
	// OIDC. Use it only behind a trusted authenticating proxy that sets the
	// header and is the sole network path to Specola — the header must not be
	// client-settable.
	TrustedUserHeader string

	// DevAuthEmail bypasses auth entirely and treats every request as this
	// user. For local development only; never set in production.
	DevAuthEmail string
}

func Load() (*Config, error) {
	c := &Config{
		ListenAddr:        env("SPECOLA_LISTEN", ":8080"),
		DatabaseURL:       os.Getenv("SPECOLA_DATABASE_URL"),
		AppBaseURL:        env("SPECOLA_BASE_URL", "http://localhost:8080"),
		SessionSecret:     os.Getenv("SPECOLA_SESSION_SECRET"),
		LogtoEndpoint:     os.Getenv("SPECOLA_LOGTO_ENDPOINT"),
		LogtoAppID:        os.Getenv("SPECOLA_LOGTO_APP_ID"),
		LogtoAppSecret:    os.Getenv("SPECOLA_LOGTO_APP_SECRET"),
		TrustedUserHeader: os.Getenv("SPECOLA_TRUSTED_USER_HEADER"),
		DevAuthEmail:      os.Getenv("SPECOLA_DEV_AUTH_EMAIL"),
	}
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("SPECOLA_DATABASE_URL is required")
	}
	if c.TrustedUserHeader == "" && !c.OIDCConfigured() && c.DevAuthEmail == "" {
		return nil, fmt.Errorf("configure one auth mode: SPECOLA_TRUSTED_USER_HEADER, SPECOLA_LOGTO_* or SPECOLA_DEV_AUTH_EMAIL")
	}
	// Own OIDC login needs a secret to sign the session cookie.
	if c.UsesOwnOIDC() && c.SessionSecret == "" {
		return nil, fmt.Errorf("SPECOLA_SESSION_SECRET is required for OIDC login")
	}
	return c, nil
}

// OIDCConfigured reports whether Logto credentials are present.
func (c *Config) OIDCConfigured() bool {
	return c.LogtoEndpoint != "" && c.LogtoAppID != "" && c.LogtoAppSecret != ""
}

// UsesOwnOIDC reports whether Specola runs its own OIDC flow (as opposed to
// trusting a proxy header, which takes precedence).
func (c *Config) UsesOwnOIDC() bool {
	return c.TrustedUserHeader == "" && c.OIDCConfigured()
}

func (c *Config) Secure() bool { return strings.HasPrefix(c.AppBaseURL, "https") }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
