package server

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/auth"
	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// newMCPBackendServer is newMCPTestServer with backends on runnerURL ("" for
// none), its health checked once.
func newMCPBackendServer(t *testing.T, fi *fakeIssuer, runnerURL string) (*httptest.Server, *Server) {
	t.Helper()
	cfg := &config.Config{
		AppBaseURL:        "http://specola.test",
		TrustedUserHeader: userHeader,
		OIDCIssuer:        fi.URL,
		MCPResource:       testResource,
	}
	if runnerURL != "" {
		cfg.RunnerURL, cfg.RunnerToken, cfg.SecretsKey = runnerURL, runnerToken, make([]byte, 32)
	}
	tokens, err := auth.NewAccessTokenVerifier(context.Background(), fi.URL, testResource)
	if err != nil {
		t.Fatal(err)
	}
	s := New(cfg, store.New(testdb.New(t)), nil, tokens)
	if s.runner != nil {
		s.runner.Check(context.Background())
	}
	ts := httptest.NewServer(s)
	t.Cleanup(ts.Close)
	return ts, s
}

func toolDescription(t *testing.T, cs *mcp.ClientSession, name string) string {
	t.Helper()
	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range tools.Tools {
		if tool.Name == name {
			return tool.Description
		}
	}
	t.Fatalf("no tool %s", name)
	return ""
}

func TestMCPBackendsDisabled(t *testing.T) {
	fi := newFakeIssuer(t)
	ts, _ := newMCPBackendServer(t, fi, "")
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	ins := cs.InitializeResult().Instructions
	const off = "Page backends are not enabled on this instance: bundles are static, `server/` code and `specola.fetch` are unavailable. Do not design apps that need them."
	if strings.Count(ins, off) != 1 {
		t.Fatalf("instructions lack the line about backends:\n%s", ins)
	}
	// And nothing else about them.
	rest := strings.Replace(ins, off, "", 1)
	for _, word := range []string{"backend", "specola.fetch", "ctx."} {
		if strings.Contains(strings.ToLower(rest), word) {
			t.Errorf("instructions say %q besides the disabled line", word)
		}
	}
	for _, tool := range []string{"create_bundle_upload", "list_versions", "get_page"} {
		if d := toolDescription(t, cs, tool); strings.Contains(strings.ToLower(d), "backend") {
			t.Errorf("%s mentions backends: %s", tool, d)
		}
	}
	var up struct {
		Backend struct {
			Enabled, Available bool
			Reason             string
		}
	}
	callTool(t, cs, "create_bundle_upload", map[string]any{"kind": "new", "title": "App"}, &up)
	if up.Backend.Enabled || up.Backend.Available || !strings.Contains(up.Backend.Reason, "not enabled") {
		t.Fatalf("create_bundle_upload backend = %+v", up.Backend)
	}
}

func TestMCPBackendsEnabled(t *testing.T) {
	fr := newFakeRunner(t)
	fi := newFakeIssuer(t)
	ts, s := newMCPBackendServer(t, fi, fr.URL)
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	ins := cs.InitializeResult().Instructions
	if strings.Contains(ins, "Page backends are not enabled") {
		t.Fatal("enabled instance says backends are off")
	}
	for _, want := range []string{"PAGE BACKENDS", "server: 'server/index.ts'", "fetch(request, ctx)", "ctx.user", "userDb",
		"specola.fetch('/api/items'", "relative paths", "survives new versions", "Only the current version", "Not available yet",
		"secrets", "egress", "cron", "push", "server code goes in a page backend"} {
		if !strings.Contains(ins, want) {
			t.Errorf("instructions lack %q", want)
		}
	}
	if strings.Contains(ins, "not answering") {
		t.Error("instructions say the runner is down")
	}
	if d := toolDescription(t, cs, "create_bundle_upload"); !strings.Contains(d, "page backend") {
		t.Errorf("create_bundle_upload doesn't mention backends: %s", d)
	}
	if d := toolDescription(t, cs, "list_versions"); !strings.Contains(d, "viewable") {
		t.Errorf("list_versions doesn't mention viewable: %s", d)
	}

	var up struct {
		UploadURL string `json:"upload_url"`
		Backend   struct {
			Enabled, Available bool
			Reason             string
		}
	}
	callTool(t, cs, "create_bundle_upload", map[string]any{"kind": "new", "title": "Shop"}, &up)
	if !up.Backend.Enabled || !up.Backend.Available || up.Backend.Reason != "" {
		t.Fatalf("create_bundle_upload backend = %+v", up.Backend)
	}
	page, _ := publishBundle(t, ts, strings.TrimPrefix(up.UploadURL, "http://specola.test"), backendBundle, "")
	if code, body := call(t, ts, "alice", "POST", "/api/pages/"+page+"/versions", `{"restoreFrom":1}`); code != 201 {
		t.Fatalf("restore: %d %s", code, body)
	}

	var vs struct {
		Versions []struct {
			Version           int
			Backend, Viewable bool
		}
	}
	callTool(t, cs, "list_versions", map[string]any{"id": page}, &vs)
	if len(vs.Versions) != 2 || !vs.Versions[0].Viewable || vs.Versions[1].Viewable || !vs.Versions[1].Backend {
		t.Fatalf("list_versions = %+v", vs)
	}
	var got struct {
		HTML    string
		Backend bool
		Note    string
	}
	callTool(t, cs, "get_page", map[string]any{"id": page, "version": 1}, &got)
	if got.HTML != backendBundle["index.html"] || !got.Backend || !strings.Contains(got.Note, "can't be opened") ||
		!strings.Contains(got.Note, "bundle") {
		t.Fatalf("get_page v1 = %+v", got)
	}
	callTool(t, cs, "get_page", map[string]any{"id": page}, &got)
	if strings.Contains(got.Note, "can't be opened") {
		t.Fatalf("get_page of the current version: %s", got.Note)
	}
	res := callTool(t, cs, "create_public_link", map[string]any{"id": page, "version": 2}, nil)
	if !res.IsError {
		t.Fatal("pinned a public link on a backend page")
	}

	// The runner's state reaches results and the next session's
	// instructions.
	s.runner.MarkUnavailable()
	callTool(t, cs, "create_bundle_upload", map[string]any{"kind": "new", "title": "Shop"}, &up)
	if !up.Backend.Enabled || up.Backend.Available || !strings.Contains(up.Backend.Reason, "not answering") {
		t.Fatalf("runner down: %+v", up.Backend)
	}
	cs2, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer cs2.Close()
	if ins := cs2.InitializeResult().Instructions; !strings.Contains(ins, "PAGE BACKENDS") || !strings.Contains(ins, "not answering") {
		t.Fatalf("instructions with the runner down:\n%s", ins)
	}
}
