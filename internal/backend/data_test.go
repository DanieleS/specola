package backend

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunnerDataRoutes(t *testing.T) {
	type got struct{ method, path, sub, ctype, body string }
	var last got
	purgeStatus := http.StatusNoContent
	rs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		b, _ := io.ReadAll(r.Body)
		last = got{r.Method, r.URL.EscapedPath(), r.Header.Get("X-Specola-Sub"), r.Header.Get("Content-Type"), string(b)}
		if r.Method == "DELETE" && r.URL.Path == "/pages/p1" {
			w.WriteHeader(purgeStatus)
			return
		}
		io.WriteString(w, "answer")
	}))
	defer rs.Close()
	r := NewRunner(rs.URL, "tok")
	ctx := context.Background()

	for _, tc := range []struct {
		call func() (*http.Response, error)
		want got
	}{
		{func() (*http.Response, error) { return r.DataUsage(ctx, "p1") }, got{"GET", "/pages/p1/data", "", "", ""}},
		{func() (*http.Response, error) { return r.CreateSnapshot(ctx, "p1", `a "b"`) },
			got{"POST", "/pages/p1/snapshots", "", "application/json", `{"kind":"manual","label":"a \"b\""}`}},
		{func() (*http.Response, error) { return r.DeleteSnapshot(ctx, "p1", "20260101T000000Z-manual") },
			got{"DELETE", "/pages/p1/snapshots/20260101T000000Z-manual", "", "", ""}},
		{func() (*http.Response, error) { return r.RestoreSnapshot(ctx, "p1", "20260101T000000Z-version-v3") },
			got{"POST", "/pages/p1/snapshots/20260101T000000Z-version-v3/restore", "", "", ""}},
		{func() (*http.Response, error) { return r.Export(ctx, "p1") }, got{"GET", "/pages/p1/export", "", "", ""}},
		{func() (*http.Response, error) { return r.Import(ctx, "p1", strings.NewReader("PK zip"), 6) },
			got{"PUT", "/pages/p1/import", "", "application/zip", "PK zip"}},
		{func() (*http.Response, error) { return r.Import(ctx, "p1", strings.NewReader("PK chunked"), -1) },
			got{"PUT", "/pages/p1/import", "", "application/zip", "PK chunked"}},
		{func() (*http.Response, error) { return r.Wipe(ctx, "p1", "users") },
			got{"POST", "/pages/p1/wipe", "", "application/json", `{"scope":"users"}`}},
		{func() (*http.Response, error) { return r.MyData(ctx, "p1", "alice@example.com") },
			got{"GET", "/pages/p1/my-data", "alice@example.com", "", ""}},
		{func() (*http.Response, error) { return r.DeleteMyData(ctx, "p1", "bob") },
			got{"DELETE", "/pages/p1/my-data", "bob", "", ""}},
		// The id is a path segment, whatever it holds.
		{func() (*http.Response, error) { return r.DataUsage(ctx, "a/../b") }, got{"GET", "/pages/a%2F..%2Fb/data", "", "", ""}},
	} {
		res, err := tc.call()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if string(b) != "answer" || last != tc.want {
			t.Errorf("got %+v (%q), want %+v", last, b, tc.want)
		}
	}

	if err := r.Purge(ctx, "p1"); err != nil || last.method != "DELETE" || last.path != "/pages/p1" {
		t.Fatalf("purge: %v %+v", err, last)
	}
	purgeStatus = http.StatusInternalServerError
	if err := r.Purge(ctx, "p1"); err == nil || !strings.Contains(err.Error(), "500") {
		t.Fatalf("failed purge: %v", err)
	}
	rs.Close()
	if err := NewRunner(rs.URL, "tok").Purge(ctx, "p1"); !Unreachable(err) {
		t.Fatalf("purge of a closed runner: %v", err)
	}
}

func TestRunnerDataStreams(t *testing.T) {
	// The answer's body streams after the method returned, deadline and all.
	next := make(chan struct{})
	rs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "one ")
		w.(http.Flusher).Flush()
		<-next
		io.WriteString(w, "two")
	}))
	defer rs.Close()
	res, err := NewRunner(rs.URL, "tok").Export(context.Background(), "p1")
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(res.Body, buf); err != nil || string(buf) != "one " {
		t.Fatalf("first chunk %q %v", buf, err)
	}
	close(next)
	rest, err := io.ReadAll(res.Body)
	if err != nil || string(rest) != "two" {
		t.Fatalf("rest %q %v", rest, err)
	}
	if err := res.Body.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestSnapshotID(t *testing.T) {
	for id, want := range map[string]bool{
		"20260101T000000Z-manual": true, "20260101T000000Z-version-v12": true, "20260101T000000Z-before-restore": true,
		"20260101T000000Z": false, "2026-01-01-manual": false, "20260101T000000Z-Manual": false, "../x": false,
		"20260101T000000Z-manual/../x": false, "": false,
	} {
		if SnapshotID.MatchString(id) != want {
			t.Errorf("SnapshotID(%q) = %v", id, !want)
		}
	}
}
