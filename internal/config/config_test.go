package config

import (
	"strings"
	"testing"
)

func TestViewOrigin(t *testing.T) {
	base := map[string]string{
		"SPECOLA_DATABASE_URL":   "postgres://x",
		"SPECOLA_DEV_AUTH_EMAIL": "dev@example.com",
		"SPECOLA_BASE_URL":       "https://specola.example.com",
	}
	for name, tc := range map[string]struct {
		env     map[string]string
		wantErr string
	}{
		"ok":          {env: map[string]string{"SPECOLA_VIEW_ORIGIN": "https://view.example.com/", "SPECOLA_SESSION_SECRET": "s"}},
		"no secret":   {env: map[string]string{"SPECOLA_VIEW_ORIGIN": "https://view.example.com"}, wantErr: "SESSION_SECRET"},
		"same host":   {env: map[string]string{"SPECOLA_VIEW_ORIGIN": "https://specola.example.com", "SPECOLA_SESSION_SECRET": "s"}, wantErr: "different host"},
		"not origin":  {env: map[string]string{"SPECOLA_VIEW_ORIGIN": "view.example.com", "SPECOLA_SESSION_SECRET": "s"}, wantErr: "not an http(s) origin"},
		"unset is ok": {env: map[string]string{}},
	} {
		t.Run(name, func(t *testing.T) {
			for k, v := range base {
				t.Setenv(k, v)
			}
			t.Setenv("SPECOLA_VIEW_ORIGIN", "")
			for k, v := range tc.env {
				t.Setenv(k, v)
			}
			c, err := Load()
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if name == "ok" && (c.ViewOrigin != "https://view.example.com" || c.ViewHost() != "view.example.com") {
				t.Fatalf("ViewOrigin %q, ViewHost %q", c.ViewOrigin, c.ViewHost())
			}
		})
	}
}

func TestBackends(t *testing.T) {
	key := "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" // 32 bytes
	for name, tc := range map[string]struct {
		url, token, secrets string
		wantErr             string
		enabled             bool
	}{
		"none":        {},
		"all":         {url: "http://runner:8090/", token: "t123456789abcdef", secrets: key, enabled: true},
		"short token": {url: "http://runner:8090", token: "devtoken1", secrets: key, wantErr: "at least 16 characters"},
		"url only":    {url: "http://runner:8090", wantErr: "missing: SPECOLA_RUNNER_TOKEN, SPECOLA_SECRETS_KEY"},
		"no key":      {url: "http://runner:8090", token: "t", wantErr: "missing: SPECOLA_SECRETS_KEY"},
		"no url":      {token: "t", secrets: key, wantErr: "missing: SPECOLA_RUNNER_URL"},
		"short key":   {url: "http://runner", token: "t123456789abcdef", secrets: "c2hvcnQ=", wantErr: "32 bytes"},
		"bad url":     {url: "runner:8090", token: "t123456789abcdef", secrets: key, wantErr: "SPECOLA_RUNNER_URL"},
		"not base64!": {url: "http://runner", token: "t123456789abcdef", secrets: "!!!", wantErr: "32 bytes"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("SPECOLA_DATABASE_URL", "postgres://x")
			t.Setenv("SPECOLA_DEV_AUTH_EMAIL", "dev@example.com")
			t.Setenv("SPECOLA_RUNNER_URL", tc.url)
			t.Setenv("SPECOLA_RUNNER_TOKEN", tc.token)
			t.Setenv("SPECOLA_SECRETS_KEY", tc.secrets)
			c, err := Load()
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if c.BackendsEnabled() != tc.enabled {
				t.Fatalf("enabled = %v", c.BackendsEnabled())
			}
			if tc.enabled && (c.RunnerURL != "http://runner:8090" || c.RunnerToken != "t123456789abcdef" || len(c.SecretsKey) != 32) {
				t.Fatalf("config = %+v", c)
			}
		})
	}
}

func TestBackendPurgeAfterDays(t *testing.T) {
	for v, want := range map[string]int{"": 0, "30": 30, " 7 ": 7, "0": -1, "-3": -1, "1.5": -1, "a week": -1, "100001": -1} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("SPECOLA_DATABASE_URL", "postgres://x")
			t.Setenv("SPECOLA_DEV_AUTH_EMAIL", "dev@example.com")
			t.Setenv("SPECOLA_BACKEND_PURGE_AFTER_DAYS", v)
			c, err := Load()
			if want < 0 {
				if err == nil || !strings.Contains(err.Error(), "SPECOLA_BACKEND_PURGE_AFTER_DAYS") {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if err != nil || c.BackendPurgeAfterDays != want {
				t.Fatalf("days = %d, err = %v", c.BackendPurgeAfterDays, err)
			}
		})
	}
}
