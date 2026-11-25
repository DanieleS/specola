// Package config loads Specola's runtime configuration from the environment.
package config

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	ListenAddr  string
	DatabaseURL string
	// AppBaseURL is the public origin, e.g. https://specola.example.com.
	// Used to build the OIDC redirect URL and to decide cookie Secure flags.
	AppBaseURL    string
	SessionSecret string

	// OIDC. OIDCIssuer is the issuer URL, e.g. https://auth.example.com/oidc.
	// The issuer alone is enough for the MCP endpoint; the client id and
	// secret are only needed for Specola's own web login.
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string

	// MCPResource is the OAuth resource indicator of the MCP endpoint: the
	// required audience of its access tokens. Defaults to <base>/mcp.
	MCPResource string

	// TrustedUserHeader, when set, makes Specola read the caller's identity from
	// this request header (e.g. X-Forwarded-User) instead of running its own
	// OIDC. Use it only behind a trusted authenticating proxy that sets the
	// header and is the sole network path to Specola — the header must not be
	// client-settable.
	TrustedUserHeader string

	// ViewOrigin, when set, serves rendered pages from this separate origin
	// (e.g. https://view.example.com) instead of the app's own, for defense in
	// depth. Both hostnames must reach this server; requests are routed by
	// Host. Viewing is authorized by short-lived signed tokens.
	ViewOrigin string

	// DevAuthEmail bypasses auth entirely and treats every request as this
	// user. For local development only; never set in production.
	DevAuthEmail string

	// Page backends (docs/page-backends.md). RunnerURL is the runner's base
	// URL; unset, backends are disabled. RunnerToken is the bearer both
	// directions of the internal API carry, and SecretsKey (32 bytes) encrypts
	// page secrets. The three come together or not at all.
	RunnerURL   string
	RunnerToken string
	SecretsKey  []byte
	// TrustForwarded makes the first X-Forwarded-For hop the client's IP
	// for the public links' rate limits (SPECOLA_TRUST_FORWARDED=1); set it
	// only behind a proxy that sets the header. Otherwise the IP is the
	// connection's.
	TrustForwarded bool
	// BackendPurgeAfterDays deletes the backend data of pages dormant (archived,
	// or whose current version has no backend) for longer than this many
	// days. 0, the default, never does.
	BackendPurgeAfterDays int

	// Test hooks, for end-to-end tests only (e2e/backends.mjs), honoured
	// only with SPECOLA_DEV_AUTH_EMAIL (a dev bypass is never production):
	// TestCronEvery (SPECOLA_TEST_CRON_EVERY, a Go duration) replaces the
	// scheduled jobs' 30 s tick, and TestClockOffset
	// (SPECOLA_TEST_CLOCK_OFFSET) moves the server's scheduling clock
	// (scheduled jobs and the purge) ahead, so a job due a minute from now
	// runs at once.
	TestCronEvery   time.Duration
	TestClockOffset time.Duration
}

func Load() (*Config, error) {
	c := &Config{
		ListenAddr:        env("SPECOLA_LISTEN", ":8080"),
		DatabaseURL:       os.Getenv("SPECOLA_DATABASE_URL"),
		AppBaseURL:        env("SPECOLA_BASE_URL", "http://localhost:8080"),
		SessionSecret:     os.Getenv("SPECOLA_SESSION_SECRET"),
		OIDCIssuer:        env("SPECOLA_OIDC_ISSUER", os.Getenv("SPECOLA_LOGTO_ENDPOINT")),
		OIDCClientID:      env("SPECOLA_OIDC_CLIENT_ID", os.Getenv("SPECOLA_LOGTO_APP_ID")),
		OIDCClientSecret:  env("SPECOLA_OIDC_CLIENT_SECRET", os.Getenv("SPECOLA_LOGTO_APP_SECRET")),
		TrustedUserHeader: os.Getenv("SPECOLA_TRUSTED_USER_HEADER"),
		DevAuthEmail:      os.Getenv("SPECOLA_DEV_AUTH_EMAIL"),
		ViewOrigin:        strings.TrimRight(os.Getenv("SPECOLA_VIEW_ORIGIN"), "/"),
		TrustForwarded:    os.Getenv("SPECOLA_TRUST_FORWARDED") == "1",
	}
	c.AppBaseURL = strings.TrimRight(c.AppBaseURL, "/")
	if err := c.loadBackends(); err != nil {
		return nil, err
	}
	if err := c.loadPurge(); err != nil {
		return nil, err
	}
	if err := c.loadTestHooks(); err != nil {
		return nil, err
	}
	c.MCPResource = env("SPECOLA_MCP_RESOURCE", c.AppBaseURL+"/mcp")
	if c.DatabaseURL == "" {
		return nil, fmt.Errorf("SPECOLA_DATABASE_URL is required")
	}
	if c.TrustedUserHeader == "" && !c.OIDCConfigured() && c.DevAuthEmail == "" {
		return nil, fmt.Errorf("configure one auth mode: SPECOLA_TRUSTED_USER_HEADER, SPECOLA_OIDC_* or SPECOLA_DEV_AUTH_EMAIL")
	}
	// Own OIDC login needs a secret to sign the session cookie.
	if c.UsesOwnOIDC() && c.SessionSecret == "" {
		return nil, fmt.Errorf("SPECOLA_SESSION_SECRET is required for OIDC login")
	}
	if c.ViewOrigin != "" {
		if c.SessionSecret == "" {
			return nil, fmt.Errorf("SPECOLA_SESSION_SECRET is required with SPECOLA_VIEW_ORIGIN, to sign view tokens")
		}
		vh, err := hostOf(c.ViewOrigin)
		if err != nil {
			return nil, fmt.Errorf("SPECOLA_VIEW_ORIGIN: %w", err)
		}
		if ah, _ := hostOf(c.AppBaseURL); strings.EqualFold(vh, ah) {
			return nil, fmt.Errorf("SPECOLA_VIEW_ORIGIN must be a different host than SPECOLA_BASE_URL")
		}
	}
	return c, nil
}

// loadBackends reads the runner settings: all of them or none. A partial
// setup is refused rather than run with backends quietly off, since pages
// published with a backend would stop working without anyone noticing why.
func (c *Config) loadBackends() error {
	vars := []string{"SPECOLA_RUNNER_URL", "SPECOLA_RUNNER_TOKEN", "SPECOLA_SECRETS_KEY"}
	var missing []string
	for _, k := range vars {
		if strings.TrimSpace(os.Getenv(k)) == "" {
			missing = append(missing, k)
		}
	}
	if len(missing) == len(vars) {
		return nil
	}
	if len(missing) > 0 {
		return fmt.Errorf("page backends need SPECOLA_RUNNER_URL, SPECOLA_RUNNER_TOKEN and SPECOLA_SECRETS_KEY together; missing: %s", strings.Join(missing, ", "))
	}
	c.RunnerURL = strings.TrimRight(strings.TrimSpace(os.Getenv("SPECOLA_RUNNER_URL")), "/")
	if _, err := hostOf(c.RunnerURL); err != nil {
		return fmt.Errorf("SPECOLA_RUNNER_URL: %w", err)
	}
	c.RunnerToken = strings.TrimSpace(os.Getenv("SPECOLA_RUNNER_TOKEN"))
	// The runner refuses to start with less (runner/src/config.js): accepting
	// it here would leave backends on with a runner that never answers.
	if len(c.RunnerToken) < 16 {
		return fmt.Errorf("SPECOLA_RUNNER_TOKEN must be at least 16 characters (e.g. openssl rand -base64 32)")
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv("SPECOLA_SECRETS_KEY")))
	if err != nil || len(key) != 32 {
		return fmt.Errorf("SPECOLA_SECRETS_KEY must be 32 bytes, base64-encoded (e.g. openssl rand -base64 32)")
	}
	c.SecretsKey = key
	return nil
}

// loadPurge reads SPECOLA_BACKEND_PURGE_AFTER_DAYS. A value that isn't a
// positive number of days is refused rather than read as "never": whoever
// set it meant data to be deleted, or meant something else entirely.
func (c *Config) loadPurge() error {
	v := strings.TrimSpace(os.Getenv("SPECOLA_BACKEND_PURGE_AFTER_DAYS"))
	if v == "" {
		return nil
	}
	n, err := strconv.Atoi(v)
	// The upper bound keeps the duration in range (about 270 years).
	if err != nil || n < 1 || n > 100_000 {
		return fmt.Errorf("SPECOLA_BACKEND_PURGE_AFTER_DAYS must be a positive number of days (leave it unset to never purge), got %q", v)
	}
	c.BackendPurgeAfterDays = n
	return nil
}

// loadTestHooks reads the SPECOLA_TEST_* variables. They are refused
// without the dev auth bypass rather than ignored, so a test that sets them
// against the wrong setup fails loudly instead of waiting for a tick that
// never comes.
func (c *Config) loadTestHooks() error {
	for _, h := range []struct {
		name string
		dst  *time.Duration
		min  time.Duration
	}{
		{"SPECOLA_TEST_CRON_EVERY", &c.TestCronEvery, 100 * time.Millisecond},
		{"SPECOLA_TEST_CLOCK_OFFSET", &c.TestClockOffset, 0},
	} {
		v := strings.TrimSpace(os.Getenv(h.name))
		if v == "" {
			continue
		}
		if c.DevAuthEmail == "" {
			return fmt.Errorf("%s is a test hook and needs SPECOLA_DEV_AUTH_EMAIL; unset it", h.name)
		}
		d, err := time.ParseDuration(v)
		if err != nil || d < h.min {
			return fmt.Errorf("%s must be a duration of at least %v (e.g. 1s), got %q", h.name, h.min, v)
		}
		*h.dst = d
	}
	return nil
}

// BackendsEnabled reports whether page backends are configured. Whether the
// runner answers is another matter (see the server's health check).
func (c *Config) BackendsEnabled() bool { return c.RunnerURL != "" }

// OIDCConfigured reports whether OIDC client credentials are present.
func (c *Config) OIDCConfigured() bool {
	return c.OIDCIssuer != "" && c.OIDCClientID != "" && c.OIDCClientSecret != ""
}

// UsesOwnOIDC reports whether Specola runs its own OIDC flow (as opposed to
// trusting a proxy header, which takes precedence).
func (c *Config) UsesOwnOIDC() bool {
	return c.TrustedUserHeader == "" && c.OIDCConfigured()
}

// MCPMode says how the MCP endpoint authenticates: "oauth" with bearer tokens
// from OIDCIssuer, "dev" as the dev-bypass user, or "" when it is off.
func (c *Config) MCPMode() string {
	switch {
	case c.OIDCIssuer != "":
		return "oauth"
	case c.DevAuthEmail != "" && c.TrustedUserHeader == "":
		return "dev"
	default:
		return ""
	}
}

// ViewHost is the host[:port] of ViewOrigin, or "" when it is unset.
func (c *Config) ViewHost() string {
	h, _ := hostOf(c.ViewOrigin)
	return h
}

func hostOf(origin string) (string, error) {
	if origin == "" {
		return "", nil
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("%q is not an http(s) origin", origin)
	}
	return u.Host, nil
}

func (c *Config) Secure() bool { return strings.HasPrefix(c.AppBaseURL, "https") }

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
