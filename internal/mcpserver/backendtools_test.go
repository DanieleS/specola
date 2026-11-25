package mcpserver

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestEncodeBody(t *testing.T) {
	for _, c := range []struct {
		name, body, ctype string
		truncated         bool
		want, enc         string
	}{
		{"empty", "", "", false, "", "utf-8"},
		{"json", `{"a":1}`, "application/json", false, `{"a":1}`, "utf-8"},
		{"text with charset", "héllo", "text/plain; charset=utf-8", false, "héllo", "utf-8"},
		{"problem+json", `{}`, "application/problem+json", false, `{}`, "utf-8"},
		{"svg", "<svg/>", "image/svg+xml", false, "<svg/>", "utf-8"},
		{"no type", "hi", "", false, base64.StdEncoding.EncodeToString([]byte("hi")), "base64"},
		{"binary type", "hi", "application/octet-stream", false, base64.StdEncoding.EncodeToString([]byte("hi")), "base64"},
		{"invalid utf-8", "caf\xe9", "text/plain", false, base64.StdEncoding.EncodeToString([]byte("caf\xe9")), "base64"},
		// Cut inside "é" (0xc3 0xa9): the partial character is dropped from
		// the text, which stays text.
		{"cut in a character", "ab\xc3", "text/plain", true, "ab", "utf-8"},
		// Not cut: an incomplete character is invalid text.
		{"incomplete, not cut", "ab\xc3", "text/plain", false, base64.StdEncoding.EncodeToString([]byte("ab\xc3")), "base64"},
		{"cut, invalid before", "\xffab\xc3", "text/plain", true, base64.StdEncoding.EncodeToString([]byte("\xffab\xc3")), "base64"},
	} {
		got, enc := encodeBody([]byte(c.body), c.ctype, c.truncated)
		if got != c.want || enc != c.enc {
			t.Errorf("%s: %q %s, want %q %s", c.name, got, enc, c.want, c.enc)
		}
	}
}

func TestExactValue(t *testing.T) {
	for in, want := range map[string]string{
		"1":                    "1",
		"9007199254740992":     "9007199254740992",
		"9007199254740993":     `"9007199254740993"`,
		"-9007199254740993":    `"-9007199254740993"`,
		"1.5":                  "1.5",
		"1e300":                "1e300",
		"99999999999999999999": "99999999999999999999", // not an int64: a float either way
	} {
		b, _ := json.Marshal(exactValue(json.Number(in)))
		if string(b) != want {
			t.Errorf("%s: %s, want %s", in, b, want)
		}
	}
	if exactValue("x") != "x" || exactValue(nil) != nil {
		t.Error("non-numbers changed")
	}
}

func TestBackendInstructions(t *testing.T) {
	on := instructions(Options{Backends: func() BackendState { return BackendState{Enabled: true, Available: true} }}, nil, "")
	if strings.Contains(on, backendsOff) || strings.Contains(on, "Not available yet") || strings.Contains(on, "not answering") {
		t.Fatalf("enabled instructions:\n%s", on)
	}
	for _, want := range []string{"backend: {", "scheduled(event, ctx)", "ctx.secrets", "publish(topic", "specola.subscribe(",
		`"public"`, `"egress"`, `"secrets"`, `"cron"`, `"topics"`, "UTC", "Backend panel", "call_backend", "backend_logs",
		"backend_query", "list_secrets", "survives new versions", "Only the current version"} {
		if !strings.Contains(on, want) {
			t.Errorf("enabled instructions lack %q", want)
		}
	}
	down := instructions(Options{Backends: func() BackendState { return BackendState{Enabled: true} }}, nil, "")
	if !strings.Contains(down, "not answering") {
		t.Error("instructions don't say the runner is down")
	}
	off := instructions(Options{}, nil, "")
	if strings.Count(off, backendsOff) != 1 || strings.Contains(off, "PAGE BACKENDS") {
		t.Fatalf("disabled instructions:\n%s", off)
	}
}
