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

	// DevAuthEmail bypasses OIDC entirely and treats every request as this
	// user. For local development only; never set in production.
	DevAuthEmail string
}

func Load() (*Config, error) {
	c := &Config{
		ListenAddr:     env("SPECOLA_LISTEN", ":8080"),
		DatabaseURL:    os.Getenv("SPECOLA_DATABASE_URL"),
		AppBaseURL:     env("SPECOLA_BASE_URL", "http://localhost:8080"),
		SessionSecret:  os.Getenv("SPECOLA_SESSION_SECRET"),
		LogtoEndpoint:  os.Getenv("SPECOLA_LOGTO_ENDPOINT"),
		LogtoAppID:     os.Getenv("SPECOLA_LOGTO_APP_ID"),
		LogtoAppSecret: os.Getenv("SPECOLA_LOGTO_APP_SECRET"),
		DevAuthEmail:   os.Getenv("SPECOLA_DEV_AUTH_EMAIL"),
	}
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("SPECOLA_DATABASE_URL is required")
	}
	if c.DevAuthEmail == "" && c.SessionSecret == "" {
		return nil, fmt.Errorf("SPECOLA_SESSION_SECRET is required (or set SPECOLA_DEV_AUTH_EMAIL for local dev)")
	}
	return c, nil
}

// OIDCConfigured reports whether real Logto login is wired up. When false the
// server falls back to DevAuthEmail.
func (c *Config) OIDCConfigured() bool {
	return c.LogtoEndpoint != "" && c.LogtoAppID != "" && c.LogtoAppSecret != ""
}

func (c *Config) Secure() bool { return strings.HasPrefix(c.AppBaseURL, "https") }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
