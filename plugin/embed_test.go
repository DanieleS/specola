package plugin

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"slices"
	"strings"
	"testing"
)

// unpack reads an npm tarball into its entries, by name.
func unpack(t *testing.T, tgz []byte) (names []string, hdrs map[string]*tar.Header, content map[string][]byte) {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(tgz))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(zr)
	hdrs, content = map[string]*tar.Header{}, map[string][]byte{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, h.Name)
		hdrs[h.Name], content[h.Name] = h, b
	}
	return names, hdrs, content
}

func TestTarballIsTheNpmPackage(t *testing.T) {
	names, hdrs, content := unpack(t, Tarball())

	var pj struct {
		Name    string
		Version string
		Bin     map[string]string
	}
	if err := json.Unmarshal(content["package/package.json"], &pj); err != nil {
		t.Fatalf("package/package.json: %v", err)
	}
	if pj.Name != "@specola/vite-plugin" || pj.Version != Version || Version == "" {
		t.Fatalf("package.json: %+v, Version %q", pj, Version)
	}
	if TarballName != "specola-vite-plugin-"+Version+".tgz" || TarballPath() != "/tools/"+TarballName {
		t.Fatalf("TarballName %q, TarballPath %q", TarballName, TarballPath())
	}

	// Exactly what npm would pack from the source directory: package.json and
	// the "files" entries. A file missing here is missing from go:embed.
	var want []string
	err := fs.WalkDir(os.DirFS("."), ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !pkg.packed(p) {
			return err
		}
		want = append(want, "package/"+p)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.IsSorted(names) || !slices.Equal(names, want) {
		t.Fatalf("tarball files\n%q\nwant (sorted)\n%q", names, want)
	}
	for _, n := range names {
		if strings.HasPrefix(n, "package/node_modules/") || strings.HasPrefix(n, "package/test/") {
			t.Fatalf("packed %s", n)
		}
		disk, err := os.ReadFile(n[len("package/"):])
		if err != nil || !bytes.Equal(disk, content[n]) {
			t.Fatalf("%s differs from the source file (%v)", n, err)
		}
		h := hdrs[n]
		mode := int64(0o644)
		if n == "package/"+pj.Bin["specola-publish"] {
			mode = 0o755
		}
		if h.Mode != mode || !h.ModTime.Equal(packTime) || h.Uid != 0 || h.Typeflag != tar.TypeReg {
			t.Fatalf("%s: mode %o, mtime %v, uid %d, type %c", n, h.Mode, h.ModTime, h.Uid, h.Typeflag)
		}
	}
	if _, ok := content["package/bin/specola-publish.js"]; !ok {
		t.Fatal("the bin is not packed")
	}
}

func TestPackIsDeterministic(t *testing.T) {
	again, err := pack(sources, pkg)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(again, Tarball()) {
		t.Fatal("packing twice gave different bytes")
	}
}

func TestCommands(t *testing.T) {
	if got := PublishCommand("https://s.test/upload/bundle/tok"); got != "npx --no -- specola-publish --upload 'https://s.test/upload/bundle/tok'" {
		t.Fatalf("PublishCommand = %q", got)
	}
	if got := InstallCommand("https://s.test/tools/x.tgz"); got != "npm i -D https://s.test/tools/x.tgz" {
		t.Fatalf("InstallCommand = %q", got)
	}
}
