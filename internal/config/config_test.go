package config

import (
	"strings"
	"testing"
	"time"
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

func TestTrustForwarded(t *testing.T) {
	t.Setenv("SPECOLA_DATABASE_URL", "postgres://x")
	t.Setenv("SPECOLA_DEV_AUTH_EMAIL", "dev@example.com")
	for v, want := range map[string]bool{"": false, "0": false, "true": false, "1": true} {
		t.Setenv("SPECOLA_TRUST_FORWARDED", v)
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		if c.TrustForwarded != want {
			t.Fatalf("SPECOLA_TRUST_FORWARDED=%q: %v, want %v", v, c.TrustForwarded, want)
		}
	}
}

func TestTestHooks(t *testing.T) {
	t.Setenv("SPECOLA_DATABASE_URL", "postgres://x")
	for name, tc := range map[string]struct {
		env           map[string]string
		every, offset time.Duration
		wantErr       string
	}{
		"unset":          {env: map[string]string{"SPECOLA_DEV_AUTH_EMAIL": "dev@example.com"}},
		"both":           {env: map[string]string{"SPECOLA_DEV_AUTH_EMAIL": "dev@example.com", "SPECOLA_TEST_CRON_EVERY": "1s", "SPECOLA_TEST_CLOCK_OFFSET": "1m"}, every: time.Second, offset: time.Minute},
		"no dev bypass":  {env: map[string]string{"SPECOLA_TRUSTED_USER_HEADER": "X-User", "SPECOLA_TEST_CRON_EVERY": "1s"}, wantErr: "needs SPECOLA_DEV_AUTH_EMAIL"},
		"offset alone":   {env: map[string]string{"SPECOLA_TRUSTED_USER_HEADER": "X-User", "SPECOLA_TEST_CLOCK_OFFSET": "1m"}, wantErr: "test hook"},
		"not a duration": {env: map[string]string{"SPECOLA_DEV_AUTH_EMAIL": "dev@example.com", "SPECOLA_TEST_CRON_EVERY": "fast"}, wantErr: "duration"},
		"too fast":       {env: map[string]string{"SPECOLA_DEV_AUTH_EMAIL": "dev@example.com", "SPECOLA_TEST_CRON_EVERY": "1ms"}, wantErr: "at least"},
		"negative":       {env: map[string]string{"SPECOLA_DEV_AUTH_EMAIL": "dev@example.com", "SPECOLA_TEST_CLOCK_OFFSET": "-1m"}, wantErr: "at least"},
	} {
		t.Run(name, func(t *testing.T) {
			for _, k := range []string{"SPECOLA_DEV_AUTH_EMAIL", "SPECOLA_TRUSTED_USER_HEADER", "SPECOLA_TEST_CRON_EVERY", "SPECOLA_TEST_CLOCK_OFFSET"} {
				t.Setenv(k, "")
			}
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
			if c.TestCronEvery != tc.every || c.TestClockOffset != tc.offset {
				t.Fatalf("every %v offset %v", c.TestCronEvery, c.TestClockOffset)
			}
		})
	}
}

func TestPublicVisitorsPerLink(t *testing.T) {
	for v, want := range map[string]int{"": DefaultPublicVisitorsPerLink, "5": 5, "0": -1, "-3": -1, "many": -1} {
		t.Run(v, func(t *testing.T) {
			t.Setenv("SPECOLA_DATABASE_URL", "postgres://x")
			t.Setenv("SPECOLA_DEV_AUTH_EMAIL", "dev@example.com")
			t.Setenv("SPECOLA_PUBLIC_VISITORS_PER_LINK", v)
			c, err := Load()
			if want < 0 {
				if err == nil || !strings.Contains(err.Error(), "SPECOLA_PUBLIC_VISITORS_PER_LINK") {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if err != nil || c.VisitorsPerLink() != want {
				t.Fatalf("visitors = %d, err = %v", c.VisitorsPerLink(), err)
			}
		})
	}
}
