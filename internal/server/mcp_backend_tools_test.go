package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danieles/specola/internal/backend"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// queryRunner is a fakeRunner that also answers POST /pages/{id}/query and
// a few /invoke paths under /mcp/ that call_backend's limits are about;
// everything else goes to the fakeRunner.
type queryRunner struct {
	*httptest.Server
	fr *fakeRunner

	mu      sync.Mutex
	queries []queryCall
}

type queryCall struct {
	page   string
	sql    string
	params json.RawMessage
}

func newQueryRunner(t *testing.T) *queryRunner {
	t.Helper()
	qr := &queryRunner{fr: newFakeRunner(t)}
	qr.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+runnerToken {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/pages/") && strings.HasSuffix(r.URL.Path, "/query") {
			qr.query(w, r)
			return
		}
		if r.Method == http.MethodPost && r.URL.Path == "/invoke" {
			var head backend.Invoke
			raw, _ := base64.RawURLEncoding.DecodeString(r.Header.Get("X-Specola-Invoke"))
			_ = json.Unmarshal(raw, &head)
			if strings.HasPrefix(head.Request.Path, "/mcp/") {
				serveMCPPath(w, r, head.Request.Path)
				return
			}
		}
		qr.fr.Config.Handler.ServeHTTP(w, r)
	}))
	t.Cleanup(qr.Close)
	return qr
}

func (qr *queryRunner) query(w http.ResponseWriter, r *http.Request) {
	var in struct {
		SQL    string          `json:"sql"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	page := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/pages/"), "/query")
	qr.mu.Lock()
	qr.queries = append(qr.queries, queryCall{page: page, sql: in.SQL, params: in.Params})
	qr.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch in.SQL {
	case "DELETE FROM t":
		w.Header().Set("X-Specola-Error", "bad-request")
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":"bad-request","message":"attempt to write a readonly database"}`)
	case "SLOW":
		w.Header().Set("X-Specola-Error", "backend-timeout")
		w.WriteHeader(http.StatusGatewayTimeout)
		io.WriteString(w, `{"error":"backend-timeout","message":"the query took too long"}`)
	default:
		io.WriteString(w, `{"columns":["id","name"],"rows":[[9007199254740993,"a"],[2,null]],"truncated":false}`)
	}
}

// serveMCPPath answers the /invoke paths under /mcp/.
func serveMCPPath(w http.ResponseWriter, r *http.Request, path string) {
	_, _ = io.Copy(io.Discard, r.Body)
	switch path {
	case "/mcp/big":
		// 100 KiB of a two-byte character after one ASCII byte: the 64 KiB
		// cut falls inside a character.
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "x"+strings.Repeat("é", 50<<10))
	case "/mcp/binary":
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write([]byte{0xff, 0x00, 0xfe})
	case "/mcp/latin1":
		// Text by its type, but not UTF-8.
		w.Header().Set("Content-Type", "text/plain; charset=iso-8859-1")
		w.Write([]byte("caf\xe9"))
	case "/mcp/endless":
		// A stream that never ends: call_backend stops reading at the cap.
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := bytes.Repeat([]byte("data: tick\n\n"), 1<<10)
		for {
			if _, err := w.Write(chunk); err != nil {
				return
			}
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(5 * time.Millisecond):
			}
		}
	}
}

// mcpSecretsBundle is an app with a backend that declares two secrets.
var mcpSecretsBundle = files{
	"index.html":                `<script type="module" src="__SPECOLA_BASE__/assets/app.js"></script>`,
	"assets/app.js":             `specola.fetch("/api")`,
	".specola/backend.json":     `{"version":1,"secrets":["API_KEY","OTHER_KEY"],"egress":["api.example.com"]}`,
	".specola/server/index.mjs": `export default { fetch: () => new Response("hi") }`,
}

func toolAnnotations(t *testing.T, cs *mcp.ClientSession, name string) *mcp.ToolAnnotations {
	t.Helper()
	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == name {
			if tool.Annotations == nil {
				return &mcp.ToolAnnotations{}
			}
			return tool.Annotations
		}
	}
	t.Fatalf("no tool %s", name)
	return nil
}

// toolErrorText is the text of a tool's error result.
func toolErrorText(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) string {
	t.Helper()
	res := callTool(t, cs, name, args, nil)
	if !res.IsError {
		b, _ := json.Marshal(res.StructuredContent)
		t.Fatalf("%s %v: no error: %s", name, args, b)
	}
	var sb strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			sb.WriteString(tc.Text)
		}
	}
	return sb.String()
}

type callBackendResult struct {
	Status       int
	Headers      map[string]string
	Body         string
	BodyEncoding string `json:"body_encoding"`
	Truncated    bool
}

func TestMCPBackendTools(t *testing.T) {
	qr := newQueryRunner(t)
	fi := newFakeIssuer(t)
	ts, s := newMCPBackendServer(t, fi, qr.URL)
	const bob = "bob@example.com"
	call(t, ts, bob, "GET", "/api/me", "") // bob signs in once

	alice, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer alice.Close()

	// Annotations: the reading tools say so; a call runs code that may
	// write.
	for _, name := range []string{"backend_logs", "backend_query", "list_secrets"} {
		if a := toolAnnotations(t, alice, name); !a.ReadOnlyHint {
			t.Errorf("%s is not read-only", name)
		}
	}
	if a := toolAnnotations(t, alice, "call_backend"); a.ReadOnlyHint || a.DestructiveHint == nil || !*a.DestructiveHint {
		t.Errorf("call_backend annotations %+v", a)
	}

	var up struct {
		UploadURL string `json:"upload_url"`
	}
	callTool(t, alice, "create_bundle_upload", map[string]any{"kind": "new", "title": "Shop"}, &up)
	page, _ := publishBundle(t, ts, strings.TrimPrefix(up.UploadURL, "http://specola.test"), mcpSecretsBundle, "")
	var plain struct{ ID string }
	callTool(t, alice, "publish_page", map[string]any{"title": "Static", "html": "<p>hi</p>"}, &plain)
	callTool(t, alice, "share", map[string]any{"kind": "page", "id": page, "email": bob, "role": "viewer"}, nil)
	bobMCP, err := connect(t, ts, fi.token(t, bob, testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer bobMCP.Close()

	t.Run("call_backend", func(t *testing.T) {
		var out callBackendResult
		callTool(t, alice, "call_backend", map[string]any{"id": page, "method": "post", "path": "/api/orders?x=1",
			"body": `{"n":1}`, "headers": map[string]any{"Content-Type": "application/json", "X-Extra": "1"}}, &out)
		c := qr.fr.last(t)
		if c.head.Request.Method != "POST" || c.head.Request.Path != "/api/orders?x=1" || c.body != `{"n":1}` ||
			c.head.Role != "owner" || c.head.User == nil || c.head.User.Sub != "alice" || c.head.Page.Version != 1 {
			t.Fatalf("runner got %+v %q", c.head, c.body)
		}
		if got, _ := json.Marshal(c.head.Request.Headers); !strings.Contains(string(got), `"application/json"`) || !strings.Contains(strings.ToLower(string(got)), `"x-extra","1"`) {
			t.Fatalf("headers %s", got)
		}
		// The handler's answer, with the header rules applied.
		if out.Status != 201 || out.Body != `{"ok":true}` || out.BodyEncoding != "utf-8" || out.Truncated ||
			out.Headers["x-kept"] != "yes" || out.Headers["set-cookie"] != "" || out.Headers["clear-site-data"] != "" ||
			out.Headers["x-content-type-options"] != "nosniff" {
			t.Fatalf("call_backend = %+v", out)
		}
		// Method defaults to GET.
		callTool(t, alice, "call_backend", map[string]any{"id": page, "path": "/"}, &out)
		if c := qr.fr.last(t); c.head.Request.Method != "GET" || out.Status != 201 {
			t.Fatalf("default method: %+v, %+v", c.head.Request, out)
		}

		// A viewer may call the backend, as the page's specola.fetch would.
		callTool(t, bobMCP, "call_backend", map[string]any{"id": page, "method": "GET", "path": "/api"}, &out)
		if c := qr.fr.last(t); c.head.Role != "viewer" || c.head.User.Sub != bob || out.Status != 201 {
			t.Fatalf("viewer call: %+v %+v", c.head, out)
		}

		// specola's and the runner's errors are answers, with their code.
		callTool(t, alice, "call_backend", map[string]any{"id": page, "method": "GET", "path": "/error"}, &out)
		if out.Status != 500 || out.Headers["x-specola-error"] != "backend-error" || !strings.Contains(out.Body, `"ref":"r1"`) {
			t.Fatalf("error answer %+v", out)
		}

		// At most 64 KiB, cut inside a character: still text.
		callTool(t, alice, "call_backend", map[string]any{"id": page, "method": "GET", "path": "/mcp/big"}, &out)
		if !out.Truncated || out.BodyEncoding != "utf-8" || len(out.Body) != 64<<10-1 || !strings.HasPrefix(out.Body, "xé") {
			t.Fatalf("big: truncated %v, %s, %d bytes", out.Truncated, out.BodyEncoding, len(out.Body))
		}
		callTool(t, alice, "call_backend", map[string]any{"id": page, "method": "GET", "path": "/mcp/binary"}, &out)
		if out.BodyEncoding != "base64" || out.Body != base64.StdEncoding.EncodeToString([]byte{0xff, 0x00, 0xfe}) || out.Truncated {
			t.Fatalf("binary: %+v", out)
		}
		callTool(t, alice, "call_backend", map[string]any{"id": page, "method": "GET", "path": "/mcp/latin1"}, &out)
		if out.BodyEncoding != "base64" || out.Body != base64.StdEncoding.EncodeToString([]byte("caf\xe9")) {
			t.Fatalf("latin1: %+v", out)
		}
		// A stream that never ends is cut at the cap, and the call ends.
		done := make(chan struct{})
		go func() {
			defer close(done)
			callTool(t, alice, "call_backend", map[string]any{"id": page, "method": "GET", "path": "/mcp/endless"}, &out)
		}()
		select {
		case <-done:
		case <-time.After(20 * time.Second):
			t.Fatal("call_backend on an endless stream didn't return")
		}
		if !out.Truncated || out.BodyEncoding != "utf-8" || len(out.Body) != 64<<10 {
			t.Fatalf("endless: truncated %v, %d bytes", out.Truncated, len(out.Body))
		}

		for args, want := range map[*map[string]any]string{
			{"id": page, "method": "TRACE", "path": "/"}:                "method must be",
			{"id": page, "method": "GET", "path": "api"}:                "must start with /",
			{"id": page, "method": "GET", "path": "/", "body": "x"}:     "can't have a body",
			{"id": "00000000-0000-0000-0000-000000000000", "path": "/"}: "page not found",
			{"id": "not-a-uuid", "path": "/"}:                           "page not found",
			{"id": plain.ID, "method": "GET", "path": "/"}:              "no backend",
		} {
			if got := toolErrorText(t, alice, "call_backend", *args); !strings.Contains(got, want) {
				t.Errorf("call_backend %v: %q, want %q", *args, got, want)
			}
		}
	})

	t.Run("backend_logs", func(t *testing.T) {
		var out struct {
			Lines []struct {
				Seq   int64
				Level string
				Text  string
			}
		}
		callTool(t, alice, "backend_logs", map[string]any{"id": page, "since": 3}, &out)
		if len(out.Lines) != 1 || out.Lines[0].Seq != 7 || out.Lines[0].Text != "page="+page+" since=3" {
			t.Fatalf("logs = %+v", out)
		}
		callTool(t, alice, "backend_logs", map[string]any{"id": page}, &out)
		if len(out.Lines) != 1 || out.Lines[0].Text != "page="+page+" since=" {
			t.Fatalf("logs without since = %+v", out)
		}
		// The canonical id reaches the runner, whatever spelling was used.
		callTool(t, alice, "backend_logs", map[string]any{"id": strings.ToUpper(page)}, &out)
		if len(out.Lines) != 1 || out.Lines[0].Text != "page="+page+" since=" {
			t.Fatalf("logs by an upper-case id = %+v", out)
		}
		if got := toolErrorText(t, alice, "backend_logs", map[string]any{"id": page, "since": -1}); !strings.Contains(got, "seq") {
			t.Errorf("since -1: %q", got)
		}
		if got := toolErrorText(t, bobMCP, "backend_logs", map[string]any{"id": page}); !strings.Contains(got, "owners and editors") {
			t.Errorf("viewer: %q", got)
		}
		if got := toolErrorText(t, alice, "backend_logs", map[string]any{"id": plain.ID}); !strings.Contains(got, "no backend") {
			t.Errorf("static page: %q", got)
		}
	})

	t.Run("backend_query", func(t *testing.T) {
		var out struct {
			Columns   []string
			Rows      [][]json.RawMessage
			Truncated bool
		}
		callTool(t, alice, "backend_query", map[string]any{"id": page, "sql": "SELECT id, name FROM t WHERE id > ?", "params": []any{1, "x"}}, &out)
		if strings.Join(out.Columns, ",") != "id,name" || len(out.Rows) != 2 || out.Truncated {
			t.Fatalf("query = %+v", out)
		}
		// A 64-bit integer keeps its digits all the way, as a string.
		if string(out.Rows[0][0]) != `"9007199254740993"` || string(out.Rows[1][0]) != "2" || string(out.Rows[1][1]) != "null" {
			t.Fatalf("rows = %s %s", out.Rows[0][0], out.Rows[1][1])
		}
		qr.mu.Lock()
		q := qr.queries[len(qr.queries)-1]
		qr.mu.Unlock()
		if q.page != page || q.sql != "SELECT id, name FROM t WHERE id > ?" || string(q.params) != `[1,"x"]` {
			t.Fatalf("runner got %+v %s", q, q.params)
		}
		callTool(t, alice, "backend_query", map[string]any{"id": page, "sql": "SELECT 1"}, &out)
		qr.mu.Lock()
		q = qr.queries[len(qr.queries)-1]
		qr.mu.Unlock()
		if string(q.params) != "[]" {
			t.Fatalf("params without any: %s", q.params)
		}

		for args, want := range map[*map[string]any]string{
			{"id": page, "sql": "DELETE FROM t"}: "readonly database",
			{"id": page, "sql": "SLOW"}:          "longer than 5 s",
			{"id": page, "sql": "  "}:            "sql is required",
			{"id": plain.ID, "sql": "SELECT 1"}:  "no backend",
		} {
			if got := toolErrorText(t, alice, "backend_query", *args); !strings.Contains(got, want) {
				t.Errorf("backend_query %v: %q, want %q", *args, got, want)
			}
		}
		if got := toolErrorText(t, bobMCP, "backend_query", map[string]any{"id": page, "sql": "SELECT 1"}); !strings.Contains(got, "owners and editors") {
			t.Errorf("viewer: %q", got)
		}
	})

	t.Run("list_secrets and get_page", func(t *testing.T) {
		type secretsOut struct {
			Secrets []struct {
				Name          string
				Declared, Set bool
				UpdatedAt     *time.Time
				UpdatedBy     string
			}
			Missing []string
			Note    string
		}
		var out secretsOut
		callTool(t, alice, "list_secrets", map[string]any{"id": page}, &out)
		if len(out.Secrets) != 2 || out.Secrets[0].Name != "API_KEY" || out.Secrets[0].Set || !out.Secrets[0].Declared ||
			strings.Join(out.Missing, ",") != "API_KEY,OTHER_KEY" || !strings.Contains(out.Note, "Backend panel") {
			t.Fatalf("list_secrets = %+v", out)
		}
		if code, body := call(t, ts, "alice", "PUT", "/api/pages/"+page+"/secrets/API_KEY", `{"value":"sk-very-secret"}`); code != http.StatusNoContent {
			t.Fatalf("set secret: %d %s", code, body)
		}
		if code, body := call(t, ts, "alice", "PUT", "/api/pages/"+page+"/secrets/OLD_KEY", `{"value":"old"}`); code != http.StatusNoContent {
			t.Fatalf("set secret: %d %s", code, body)
		}
		res := callTool(t, alice, "list_secrets", map[string]any{"id": page}, &out)
		if b, _ := json.Marshal(res); strings.Contains(string(b), "sk-very-secret") {
			t.Fatal("list_secrets shows a value")
		}
		if len(out.Secrets) != 3 || out.Secrets[0].Name != "API_KEY" || !out.Secrets[0].Set || out.Secrets[0].UpdatedBy != "alice" ||
			out.Secrets[0].UpdatedAt == nil || out.Secrets[1].Name != "OLD_KEY" || out.Secrets[1].Declared || !out.Secrets[1].Set ||
			strings.Join(out.Missing, ",") != "OTHER_KEY" {
			t.Fatalf("list_secrets after set = %+v", out)
		}
		if got := toolErrorText(t, bobMCP, "list_secrets", map[string]any{"id": page}); !strings.Contains(got, "owners and editors") {
			t.Errorf("viewer: %q", got)
		}
		if got := toolErrorText(t, alice, "list_secrets", map[string]any{"id": plain.ID}); !strings.Contains(got, "no backend") {
			t.Errorf("static page: %q", got)
		}

		type getPageOut struct {
			Backend *struct {
				Manifest       *backend.Manifest
				SecretsMissing *[]string `json:"secrets_missing"`
			}
		}
		var got getPageOut
		res = callTool(t, alice, "get_page", map[string]any{"id": page}, &got)
		if got.Backend == nil || got.Backend.Manifest == nil || strings.Join(got.Backend.Manifest.Secrets, ",") != "API_KEY,OTHER_KEY" ||
			got.Backend.Manifest.Entry != "server/index.mjs" || got.Backend.SecretsMissing == nil ||
			strings.Join(*got.Backend.SecretsMissing, ",") != "OTHER_KEY" {
			b, _ := json.Marshal(res.StructuredContent)
			t.Fatalf("get_page backend: %s", b)
		}
		// A viewer sees the manifest, not which secrets are missing.
		got = getPageOut{}
		callTool(t, bobMCP, "get_page", map[string]any{"id": page}, &got)
		if got.Backend == nil || got.Backend.Manifest == nil || got.Backend.SecretsMissing != nil {
			t.Fatalf("get_page as a viewer: %+v", got.Backend)
		}
		// All set: an empty list, not none.
		if code, body := call(t, ts, "alice", "PUT", "/api/pages/"+page+"/secrets/OTHER_KEY", `{"value":"v"}`); code != http.StatusNoContent {
			t.Fatalf("set secret: %d %s", code, body)
		}
		got = getPageOut{}
		callTool(t, alice, "get_page", map[string]any{"id": page}, &got)
		if got.Backend == nil || got.Backend.SecretsMissing == nil || len(*got.Backend.SecretsMissing) != 0 {
			t.Fatalf("get_page with every secret set: %+v", got.Backend)
		}
		// A page without a backend: null.
		var raw map[string]json.RawMessage
		res = callTool(t, alice, "get_page", map[string]any{"id": plain.ID}, nil)
		b, _ := json.Marshal(res.StructuredContent)
		mustJSON(t, string(b), &raw)
		if string(raw["backend"]) != "null" {
			t.Fatalf("get_page of a static page: backend %s", raw["backend"])
		}
	})

	t.Run("runner down", func(t *testing.T) {
		qr.Close()
		if got := toolErrorText(t, alice, "backend_logs", map[string]any{"id": page}); !strings.Contains(got, "not available") {
			t.Errorf("logs: %q", got)
		}
		if s.runner.Available() {
			t.Error("an unreachable runner is still available")
		}
		if got := toolErrorText(t, alice, "backend_query", map[string]any{"id": page, "sql": "SELECT 1"}); !strings.Contains(got, "not available") {
			t.Errorf("query: %q", got)
		}
		var out callBackendResult
		callTool(t, alice, "call_backend", map[string]any{"id": page, "path": "/"}, &out)
		if out.Status != 503 || out.Headers["x-specola-error"] != "backend-unavailable" {
			t.Errorf("call with the runner down: %+v", out)
		}
	})
}

func TestMCPBackendToolsDisabled(t *testing.T) {
	fi := newFakeIssuer(t)
	ts, _ := newMCPBackendServer(t, fi, "")
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()
	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		switch tool.Name {
		case "call_backend", "backend_logs", "backend_query", "list_secrets":
			t.Errorf("%s offered without backends", tool.Name)
		}
	}
	// get_page still answers, with no backend.
	var pub struct{ ID string }
	callTool(t, cs, "publish_page", map[string]any{"title": "P", "html": "<p>hi</p>"}, &pub)
	res := callTool(t, cs, "get_page", map[string]any{"id": pub.ID}, nil)
	if res.IsError {
		t.Fatal("get_page failed")
	}
}
