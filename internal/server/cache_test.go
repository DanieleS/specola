package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestViewCaching(t *testing.T) {
	ts := newTestServer(t)
	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"P","html":"<p>v1</p>"}`)
	id := createdID(t, code, body)
	alice := http.Header{userHeader: {"alice"}}

	// A numbered version never changes: the browser may keep it.
	res := get(t, ts, "", "/view/"+id+"?v=1", alice)
	if cc := res.Header.Get("Cache-Control"); res.StatusCode != http.StatusOK || cc != "private, max-age=31536000, immutable" {
		t.Fatalf("?v=1: %d, Cache-Control %q", res.StatusCode, cc)
	}

	// The current version is revalidated against its content hash.
	res = get(t, ts, "", "/view/"+id, alice)
	etag := res.Header.Get("ETag")
	if res.StatusCode != http.StatusOK || etag == "" || res.Header.Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("current: %d, ETag %q, Cache-Control %q", res.StatusCode, etag, res.Header.Get("Cache-Control"))
	}
	revalidate := http.Header{userHeader: {"alice"}, "If-None-Match": {etag}}
	if res := get(t, ts, "", "/view/"+id, revalidate); res.StatusCode != http.StatusNotModified {
		t.Fatalf("revalidate unchanged: %d, want 304", res.StatusCode)
	}

	// A new version changes the tag, so the same request now gets the page.
	call(t, ts, "alice", "POST", "/api/pages/"+id+"/versions", `{"html":"<p>v2</p>"}`)
	res = get(t, ts, "", "/view/"+id, revalidate)
	if res.StatusCode != http.StatusOK || res.Header.Get("ETag") == etag {
		t.Fatalf("after v2: %d, ETag %q (was %q)", res.StatusCode, res.Header.Get("ETag"), etag)
	}
	if got := readBody(t, res); got != withSDK("<p>v2</p>") {
		t.Fatalf("after v2: body %q", got)
	}

	// The tag is no credential: someone who can't see the page gets 404, and
	// an error is never marked cacheable.
	stale := `W/"` + strings.Trim(strings.TrimPrefix(etag, "W/"), `"`) + `"`
	for _, path := range []string{"/view/" + id, "/view/" + id + "?v=1"} {
		res := get(t, ts, "", path, http.Header{userHeader: {"bob"}, "If-None-Match": {stale}})
		if res.StatusCode != http.StatusNotFound || res.Header.Get("Cache-Control") != "" || res.Header.Get("ETag") != "" {
			t.Fatalf("bob %s: %d, Cache-Control %q, ETag %q", path, res.StatusCode, res.Header.Get("Cache-Control"), res.Header.Get("ETag"))
		}
	}
	if res := get(t, ts, "", "/view/"+id+"?v=9", alice); res.StatusCode != http.StatusNotFound || res.Header.Get("Cache-Control") != "" {
		t.Fatalf("missing version: %d, Cache-Control %q", res.StatusCode, res.Header.Get("Cache-Control"))
	}
}

func TestEtagMatches(t *testing.T) {
	const etag = `W/"abc"`
	for header, want := range map[string]bool{
		"":             false,
		`"abc"`:        true,
		`W/"abc"`:      true,
		`"x", W/"abc"`: true,
		`*`:            true,
		`"abcd"`:       false,
		`"x", "y"`:     false,
	} {
		if got := etagMatches(header, etag); got != want {
			t.Errorf("etagMatches(%q) = %v, want %v", header, got, want)
		}
	}
}

func TestPagesAreCompressed(t *testing.T) {
	ts := newTestServer(t)
	html := strings.Repeat("<p>the same paragraph again</p>", 300)
	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"Big","html":"`+html+`"}`)
	id := createdID(t, code, body)

	// Setting Accept-Encoding ourselves turns off the client's transparent
	// decompression, so the response arrives as the server sent it.
	res := get(t, ts, "", "/view/"+id+"?v=1", http.Header{userHeader: {"alice"}, "Accept-Encoding": {"gzip"}})
	if res.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", res.Header.Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	if string(plain) != withSDK(html) {
		t.Fatalf("decompressed body differs: %d bytes, want %d", len(plain), len(html))
	}
	// The sandbox must survive compression.
	if !strings.Contains(res.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("CSP lost: %q", res.Header.Get("Content-Security-Policy"))
	}
}

func TestShellIsRevalidated(t *testing.T) {
	ts := newTestServer(t)
	for _, path := range []string{"/", "/some/spa/route"} {
		res := get(t, ts, "", path, nil)
		if res.StatusCode != http.StatusOK || res.Header.Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: %d, Cache-Control %q", path, res.StatusCode, res.Header.Get("Cache-Control"))
		}
	}
}
