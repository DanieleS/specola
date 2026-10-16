package server

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/danieles/specola/internal/auth"
	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/internal/testdb"

	"github.com/go-jose/go-jose/v4"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const testResource = "https://specola.test/mcp"

// fakeIssuer is a minimal OIDC provider: discovery, a JWKS, and a way to mint
// signed access tokens.
type fakeIssuer struct {
	*httptest.Server
	signer jose.Signer
}

func newFakeIssuer(t *testing.T) *fakeIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithType("at+jwt").WithHeader("kid", "k1"))
	if err != nil {
		t.Fatal(err)
	}
	fi := &fakeIssuer{signer: signer}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                fi.URL,
			"authorization_endpoint":                fi.URL + "/auth",
			"token_endpoint":                        fi.URL + "/token",
			"jwks_uri":                              fi.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: &key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"},
		}})
	})
	fi.Server = httptest.NewServer(mux)
	t.Cleanup(fi.Close)
	return fi
}

// token mints an access token for sub with the given audience.
func (fi *fakeIssuer) token(t *testing.T, sub, aud string) string {
	t.Helper()
	claims, _ := json.Marshal(map[string]any{
		"iss": fi.URL, "sub": sub, "aud": aud,
		"iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
	})
	obj, err := fi.signer.Sign(claims)
	if err != nil {
		t.Fatal(err)
	}
	s, err := obj.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// newMCPTestServer runs Specola with the MCP endpoint trusting fi, and the
// REST API in trusted-header mode so tests can check results as a given user.
func newMCPTestServer(t *testing.T, fi *fakeIssuer) *httptest.Server {
	t.Helper()
	cfg := &config.Config{
		AppBaseURL:        "http://specola.test",
		TrustedUserHeader: userHeader,
		OIDCIssuer:        fi.URL,
		MCPResource:       testResource,
	}
	tokens, err := auth.NewAccessTokenVerifier(context.Background(), fi.URL, testResource)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(New(cfg, store.New(testdb.New(t)), nil, tokens))
	t.Cleanup(ts.Close)
	return ts
}

type bearerTransport struct{ token string }

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

func connect(t *testing.T, ts *httptest.Server, token string) (*mcp.ClientSession, error) {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	return client.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:             ts.URL + "/mcp",
		HTTPClient:           &http.Client{Transport: bearerTransport{token}},
		DisableStandaloneSSE: true,
	}, nil)
}

// callTool calls a tool and decodes its structured output into out.
func callTool(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any, out any) *mcp.CallToolResult {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	if out != nil && !res.IsError {
		b, _ := json.Marshal(res.StructuredContent)
		if err := json.Unmarshal(b, out); err != nil {
			t.Fatalf("%s: decode %s: %v", name, b, err)
		}
	}
	return res
}

func TestMCPProtectedResourceMetadata(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)

	for _, path := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"} {
		code, body := call(t, ts, "", "GET", path, "")
		if code != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, code, body)
		}
		var meta struct {
			Resource             string   `json:"resource"`
			AuthorizationServers []string `json:"authorization_servers"`
		}
		mustJSON(t, body, &meta)
		if meta.Resource != testResource || len(meta.AuthorizationServers) != 1 || meta.AuthorizationServers[0] != fi.URL {
			t.Fatalf("GET %s: %+v", path, meta)
		}
	}
}

func TestMCPRejectsMissingOrForeignTokens(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)

	for name, token := range map[string]string{
		"none":         "",
		"garbage":      "not-a-jwt",
		"other aud":    fi.token(t, "alice", "https://elsewhere.test/api"),
		"other issuer": newFakeIssuer(t).token(t, "alice", testResource),
	} {
		req, _ := http.NewRequest("POST", ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, res.StatusCode)
		}
		want := `Bearer resource_metadata="http://specola.test/.well-known/oauth-protected-resource"`
		if got := res.Header.Get("WWW-Authenticate"); got != want {
			t.Errorf("%s: WWW-Authenticate %q, want %q", name, got, want)
		}
	}
}

func TestMCPPublishActsAsTheTokenUser(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)

	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer cs.Close()

	tools, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tool := range tools.Tools {
		names = append(names, tool.Name)
	}
	for _, want := range []string{"publish_page", "new_version", "list", "get_page"} {
		if !strings.Contains(strings.Join(names, ","), want) {
			t.Fatalf("tools = %v, missing %s", names, want)
		}
	}

	var pub struct {
		ID      string
		Version int
		URL     string
	}
	callTool(t, cs, "publish_page", map[string]any{"title": "From agent", "html": "<p>v1</p>"}, &pub)
	if pub.ID == "" || pub.Version != 1 || pub.URL != "http://specola.test/#/p/"+pub.ID {
		t.Fatalf("publish_page = %+v", pub)
	}

	var nv struct{ Version int }
	callTool(t, cs, "new_version", map[string]any{"id": pub.ID, "html": "<p>v2</p>"}, &nv)
	if nv.Version != 2 {
		t.Fatalf("new_version = %+v", nv)
	}

	var page struct {
		Name    string
		Version int
		HTML    string
	}
	callTool(t, cs, "get_page", map[string]any{"id": pub.ID}, &page)
	if page.Name != "From agent" || page.Version != 2 || page.HTML != "<p>v2</p>" {
		t.Fatalf("get_page = %+v", page)
	}

	var list struct{ Items []struct{ ID, URL string } }
	callTool(t, cs, "list", map[string]any{}, &list)
	if len(list.Items) != 1 || list.Items[0].ID != pub.ID || list.Items[0].URL == "" {
		t.Fatalf("list = %+v", list)
	}

	// The page is in alice's web gallery, and nobody else's.
	if _, body := call(t, ts, "alice", "GET", "/view/"+pub.ID, ""); body != "<p>v2</p>" {
		t.Fatalf("alice /view = %q", body)
	}
	if code, _ := call(t, ts, "bob", "GET", "/view/"+pub.ID, ""); code != http.StatusNotFound {
		t.Fatalf("bob /view: %d, want 404", code)
	}

	// Another user's token can't touch it.
	bob, err := connect(t, ts, fi.token(t, "bob", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer bob.Close()
	if res := callTool(t, bob, "get_page", map[string]any{"id": pub.ID}, nil); !res.IsError {
		t.Fatalf("bob get_page succeeded: %+v", res)
	}
	if res := callTool(t, bob, "new_version", map[string]any{"id": pub.ID, "html": "x"}, nil); !res.IsError {
		t.Fatalf("bob new_version succeeded: %+v", res)
	}
}

func TestMCPUploadGrant(t *testing.T) {
	fi := newFakeIssuer(t)
	ts := newMCPTestServer(t, fi)
	cs, err := connect(t, ts, fi.token(t, "alice", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer cs.Close()

	var grant struct {
		UploadURL string `json:"upload_url"`
		Method    string
		Curl      string
	}
	callTool(t, cs, "create_upload_grant", map[string]any{"kind": "new", "title": "Large"}, &grant)
	const prefix = "http://specola.test/upload/"
	if !strings.HasPrefix(grant.UploadURL, prefix) || grant.Method != "PUT" || !strings.Contains(grant.Curl, grant.UploadURL) {
		t.Fatalf("grant = %+v", grant)
	}
	path := "/upload/" + strings.TrimPrefix(grant.UploadURL, prefix)

	// No session or token: the grant itself is the credential.
	html := "<p>" + strings.Repeat("x", 300<<10) + "</p>"
	code, body := call(t, ts, "", "PUT", path, html)
	if code != http.StatusCreated {
		t.Fatalf("upload: %d %s", code, body)
	}
	var up struct {
		ID      string
		Version int
		URL     string
	}
	mustJSON(t, body, &up)
	if up.Version != 1 || up.URL != "http://specola.test/#/p/"+up.ID {
		t.Fatalf("upload = %+v", up)
	}
	if _, got := call(t, ts, "alice", "GET", "/view/"+up.ID, ""); got != html {
		t.Fatalf("alice /view: %d bytes, want %d", len(got), len(html))
	}

	if code, _ := call(t, ts, "", "PUT", path, "<p>again</p>"); code != http.StatusGone {
		t.Fatalf("second use: %d, want 410", code)
	}
	if code, _ := call(t, ts, "", "PUT", "/upload/unknown", "<p>x</p>"); code != http.StatusNotFound {
		t.Fatalf("unknown token: %d, want 404", code)
	}

	// Version grants for someone else's page are refused at mint time.
	bob, err := connect(t, ts, fi.token(t, "bob", testResource))
	if err != nil {
		t.Fatal(err)
	}
	defer bob.Close()
	if res := callTool(t, bob, "create_upload_grant", map[string]any{"kind": "version", "id": up.ID}, nil); !res.IsError {
		t.Fatalf("bob grant on alice's page succeeded: %+v", res)
	}
}
