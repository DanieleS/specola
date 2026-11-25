package backend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunnerScheduled(t *testing.T) {
	var got map[string]any
	var answer func(w http.ResponseWriter)
	rs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/scheduled" || r.Header.Get("Authorization") != "Bearer tok" {
			http.NotFound(w, r)
			return
		}
		raw, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Specola-Invoke"))
		got = nil
		_ = json.Unmarshal(raw, &got)
		if b, _ := io.ReadAll(r.Body); len(b) != 0 {
			t.Errorf("body %q", b)
		}
		answer(w)
	}))
	defer rs.Close()
	r := NewRunner(rs.URL, "tok")
	ctx := context.Background()
	head := ScheduledHead{
		Page: Page{ID: "p", Version: 3, Title: "T"}, VersionID: "v", CodeHash: "h",
		// Whatever the caller says, a scheduled run has no user and the cron role.
		User: &User{Sub: "x"}, Role: "owner",
		Secrets: map[string]string{"K": "v"},
		Event:   Event{Name: "nightly", ScheduledTime: 1700000000000},
	}

	answer = func(w http.ResponseWriter) { io.WriteString(w, `{"status":"ok"}`) }
	res, err := r.Scheduled(ctx, head)
	if err != nil || res != (ScheduledResult{Status: CronOK}) {
		t.Fatalf("ok: %+v %v", res, err)
	}
	b, _ := json.Marshal(got)
	want := `{"codeHash":"h","egress":[],"event":{"name":"nightly","scheduledTime":1700000000000},"link":null,` +
		`"page":{"id":"p","title":"T","version":3},"role":"cron","secrets":{"K":"v"},"user":null,"versionId":"v"}`
	if string(b) != want {
		t.Fatalf("head = %s\nwant %s", b, want)
	}
	if _, ok := got["request"]; ok {
		t.Fatal("a scheduled head has a request")
	}

	answer = func(w http.ResponseWriter) { io.WriteString(w, `{"status":"error","ref":"r9"}`) }
	if res, err := r.Scheduled(ctx, head); err != nil || res != (ScheduledResult{Status: CronError, Ref: "r9"}) {
		t.Fatalf("error: %+v %v", res, err)
	}
	answer = func(w http.ResponseWriter) { io.WriteString(w, `{"status":"no-handler"}`) }
	if res, _ := r.Scheduled(ctx, head); res.Status != CronNoHandler {
		t.Fatalf("no-handler: %+v", res)
	}
	answer = func(w http.ResponseWriter) { io.WriteString(w, `{"status":"weird"}`) }
	if res, _ := r.Scheduled(ctx, head); res.Status != CronError || !strings.Contains(res.Message, "weird") {
		t.Fatalf("unknown status: %+v", res)
	}

	// The runner's own errors are results, with their message and ref.
	for code, status := range map[string]string{"backend-timeout": CronTimeout, "backend-crashed": CronError,
		"backend-unavailable": CronUnavailable, "superseded": CronError} {
		answer = func(w http.ResponseWriter) {
			w.Header().Set("X-Specola-Error", code)
			w.WriteHeader(http.StatusInternalServerError)
			io.WriteString(w, `{"error":"`+code+`","message":"boom","ref":"r1"}`)
		}
		if res, err := r.Scheduled(ctx, head); err != nil || res != (ScheduledResult{Status: status, Ref: "r1", Message: "boom"}) {
			t.Errorf("%s: %+v %v", code, res, err)
		}
	}
	answer = func(w http.ResponseWriter) { w.WriteHeader(http.StatusBadGateway) }
	if res, err := r.Scheduled(ctx, head); err != nil || res.Status != CronError || !strings.Contains(res.Message, "502") {
		t.Fatalf("bare 502: %+v %v", res, err)
	}

	rs.Close()
	// A new client: the old one's idle keep-alive connection would answer
	// EOF (the server went away mid-connection) rather than fail to dial.
	if _, err := NewRunner(rs.URL, "tok").Scheduled(ctx, head); err == nil || !Unreachable(err) {
		t.Fatalf("closed runner: %v", err)
	}
}

// A head whose secrets push it over the runner's header limit isn't sent:
// the run is an error that says why, not the runner's bare 400.
func TestRunnerScheduledSecretsTooLarge(t *testing.T) {
	called := false
	rs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer rs.Close()
	secrets := map[string]string{}
	for _, n := range []string{"A", "B", "C", "D", "E"} {
		secrets[n] = strings.Repeat("s", 8<<10)
	}
	res, err := NewRunner(rs.URL, "tok").Scheduled(context.Background(), ScheduledHead{Secrets: secrets, Event: Event{Name: "j"}})
	if err != nil || res.Status != CronError || !strings.Contains(res.Message, "secrets are too large") || called {
		t.Fatalf("%+v %v called=%v", res, err, called)
	}
}

func TestSecretsHeadBytes(t *testing.T) {
	if n := SecretsHeadBytes(map[string]string{}); n != 3 { // "{}"
		t.Fatalf("empty = %d", n)
	}
	// encoding/json's escapes count: < is \u003c.
	if a, b := SecretsHeadBytes(map[string]string{"K": "<<<"}), SecretsHeadBytes(map[string]string{"K": "aaa"}); a <= b {
		t.Fatalf("escaped %d, plain %d", a, b)
	}
	if SecretsTooLarge(map[string]string{"K": "v"}) != "" {
		t.Fatal("a small secret is too large")
	}
	big := map[string]string{"A": strings.Repeat("x", 8<<10), "B": strings.Repeat("x", 8<<10), "C": strings.Repeat("x", 8<<10)}
	if msg := SecretsTooLarge(big); !strings.Contains(msg, "at most 24 KiB") {
		t.Fatalf("message %q", msg)
	}
}
