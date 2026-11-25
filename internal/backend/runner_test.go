package backend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRunnerHealth(t *testing.T) {
	var answer atomic.Value
	answer.Store(`{"ok":true,"version":"0.1.0"}`)
	rs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" || r.Header.Get("Authorization") != "Bearer tok" {
			http.NotFound(w, r)
			return
		}
		io.WriteString(w, answer.Load().(string))
	}))
	defer rs.Close()

	r := NewRunner(rs.URL, "tok")
	if r.Available() {
		t.Fatal("available before any check")
	}
	if !r.Check(context.Background()) || !r.Available() || r.version.Load() != "0.1.0" {
		t.Fatal("healthy runner not available")
	}
	answer.Store(`{"ok":false}`)
	if r.Check(context.Background()) || r.Available() {
		t.Fatal(`{"ok":false} counted as available`)
	}
	answer.Store(`{"ok":true}`)
	r.Check(context.Background())
	r.MarkUnavailable()
	if r.Available() {
		t.Fatal("still available after MarkUnavailable")
	}
	if NewRunner(rs.URL, "wrong").Check(context.Background()) {
		t.Fatal("a 404 counted as available")
	}
	rs.Close()
	if r.Check(context.Background()) {
		t.Fatal("a closed runner counted as available")
	}
}

func TestRunnerAuthorized(t *testing.T) {
	r := NewRunner("http://runner", "s3cret")
	for h, want := range map[string]bool{
		"Bearer s3cret": true, "Bearer s3cre": false, "Bearer s3cret ": false, "s3cret": false, "": false, "Basic s3cret": false,
	} {
		if r.Authorized(h) != want {
			t.Errorf("Authorized(%q) = %v", h, !want)
		}
	}
}

func TestRunnerInvoke(t *testing.T) {
	var got Invoke
	var body string
	rs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Specola-Invoke"))
		if err != nil || r.URL.Path != "/invoke" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "bad", 400)
			return
		}
		_ = json.Unmarshal(raw, &got)
		b, _ := io.ReadAll(r.Body)
		body = string(b)
		w.Header().Set("Content-Encoding", "gzip") // passed through, not decoded
		io.WriteString(w, "raw")
	}))
	defer rs.Close()
	head, err := EncodeInvoke(&Invoke{
		Page: Page{ID: "p", Version: 3, Title: "T"}, VersionID: "v", CodeHash: "h",
		Role: "owner", Secrets: map[string]string{}, Egress: []string{},
		Request: Request{Method: "POST", Path: "/api?x=1", Headers: [][2]string{{"content-type", "text/plain"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	res, err := NewRunner(rs.URL, "tok").Invoke(context.Background(), head, strings.NewReader("hello"), 5)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || string(b) != "raw" || body != "hello" || got.Page.Version != 3 ||
		got.Request.Headers[0] != [2]string{"content-type", "text/plain"} || got.User != nil {
		t.Fatalf("status %d body %q, runner got %+v and %q", res.StatusCode, b, got, body)
	}
	// The wire format: user and link are null, not missing.
	raw, _ := base64.RawURLEncoding.DecodeString(head)
	if !strings.Contains(string(raw), `"user":null`) || !strings.Contains(string(raw), `"link":null`) ||
		!strings.Contains(string(raw), `"headers":[["content-type","text/plain"]]`) {
		t.Fatalf("head = %s", raw)
	}
}
