package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/danieles/specola/internal/config"
	"github.com/danieles/specola/internal/store"
	"github.com/danieles/specola/plugin"
)

// newToolsTestServer needs no database: the plugin is served from memory.
func newToolsTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(New(&config.Config{AppBaseURL: "http://test"}, store.New(nil), nil, nil))
	t.Cleanup(ts.Close)
	return ts
}

func TestPluginTarballIsServed(t *testing.T) {
	ts := newToolsTestServer(t)
	path := "/tools/" + plugin.TarballName

	res := get(t, ts, "", path, http.Header{"Accept-Encoding": {"gzip"}})
	body := readBody(t, res)
	if res.StatusCode != http.StatusOK || body != string(plugin.Tarball()) {
		t.Fatalf("GET %s: %d, %d bytes (want %d)", path, res.StatusCode, len(body), len(plugin.Tarball()))
	}
	for h, want := range map[string]string{
		"Content-Type":           "application/gzip",
		"Cache-Control":          "public, max-age=31536000, immutable",
		"Content-Encoding":       "", // already gzip: never compressed again
		"ETag":                   `"` + plugin.TarballSHA256 + `"`,
		"X-Content-Type-Options": "nosniff",
	} {
		if got := res.Header.Get(h); got != want {
			t.Errorf("%s = %q, want %q", h, got, want)
		}
	}

	// Only this server's version is served, under its own name.
	for _, p := range []string{"/tools/specola-vite-plugin-0.0.1.tgz", "/tools/specola-vite-plugin.tgz", "/tools/package.json", "/tools/", "/tools/a/" + plugin.TarballName} {
		if res := get(t, ts, "", p, nil); res.StatusCode != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", p, res.StatusCode)
		}
	}
	req, _ := http.NewRequest("HEAD", ts.URL+path, nil)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusOK || res.ContentLength != int64(len(plugin.Tarball())) {
		t.Fatalf("HEAD: %v %v", res, err)
	}
}

// TestPluginInstallsWithNpm installs the served package the way an agent is
// told to, which proves npm accepts it and links the bin.
func TestPluginInstallsWithNpm(t *testing.T) {
	npm, err := exec.LookPath("npm")
	if err != nil {
		t.Skip("npm is not installed")
	}
	ts := newToolsTestServer(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "package.json"), []byte(`{"name":"app","private":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	// No peers: vite would come from the registry, and isn't what is tested.
	cmd := exec.Command(npm, "install", "--save-dev", "--legacy-peer-deps", "--ignore-scripts",
		"--no-audit", "--no-fund", "--cache", filepath.Join(dir, ".npm-cache"), ts.URL+"/tools/"+plugin.TarballName)
	cmd.Dir = dir
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		t.Fatalf("npm install: %v\n%s", err, out.String())
	}

	b, err := os.ReadFile(filepath.Join(dir, "node_modules", "@specola", "vite-plugin", "package.json"))
	if err != nil {
		t.Fatal(err)
	}
	var pj struct{ Version string }
	if err := json.Unmarshal(b, &pj); err != nil || pj.Version != plugin.Version {
		t.Fatalf("installed package.json: %s (%v)", b, err)
	}
	bin := filepath.Join(dir, "node_modules", ".bin", "specola-publish")
	if fi, err := os.Stat(bin); err != nil || fi.Mode()&0o111 == 0 {
		t.Fatalf("bin %s: %v %v", bin, fi, err)
	}
	// The bin runs: --help needs no network and no Vite.
	help := exec.Command(bin, "--help")
	help.Dir = dir
	if out, err := help.CombinedOutput(); err != nil || !bytes.Contains(out, []byte("--upload")) {
		t.Fatalf("specola-publish --help: %v\n%s", err, out)
	}
}
