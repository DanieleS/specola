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
