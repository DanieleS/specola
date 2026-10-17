package server

import (
	"net/http"
	"strings"
	"testing"

	"github.com/danieles/specola/internal/store"
)

func TestPageData(t *testing.T) {
	ts := newTestServer(t)
	const alice, bob, carol = "alice@example.com", "bob@example.com", "carol@example.com"
	call(t, ts, bob, "GET", "/api/me", "")
	code, body := call(t, ts, alice, "POST", "/api/pages", `{"name":"Todo","html":"<p>todo</p>"}`)
	page := createdID(t, code, body)
	path := "/api/pages/" + page + "/data"

	data := func(user string) map[string]string {
		t.Helper()
		code, body := call(t, ts, user, "GET", path, "")
		if code != http.StatusOK {
			t.Fatalf("%s GET data: %d %s", user, code, body)
		}
		var d map[string]string
		mustJSON(t, body, &d)
		return d
	}
	expect := func(user, method, body string, want int) {
		t.Helper()
		if code, got := call(t, ts, user, method, path, body); code != want {
			t.Fatalf("%s %s data %s: %d %s, want %d", user, method, body, code, got, want)
		}
	}

	if d := data(alice); len(d) != 0 {
		t.Fatalf("new page data = %v", d)
	}
	expect(alice, "PATCH", `{"set":{"done":"[1,2]","theme":"dark"}}`, http.StatusNoContent)
	expect(alice, "PATCH", `{"set":{"done":"[1,2,3]"},"remove":["theme","missing"]}`, http.StatusNoContent)
	if d := data(alice); len(d) != 1 || d["done"] != "[1,2,3]" {
		t.Fatalf("after updates = %v", d)
	}

	// Someone who can't see the page can't reach its data.
	expect(bob, "GET", "", http.StatusNotFound)
	expect(bob, "PATCH", `{"set":{"x":"1"}}`, http.StatusNotFound)

	// A viewer keeps data of their own, and sees none of the owner's.
	call(t, ts, alice, "PUT", "/api/pages/"+page+"/acl", `{"email":"`+bob+`","role":"viewer"}`)
	if d := data(bob); len(d) != 0 {
		t.Fatalf("bob sees %v", d)
	}
	expect(bob, "PATCH", `{"set":{"done":"[9]"}}`, http.StatusNoContent)
	if a, b := data(alice), data(bob); a["done"] != "[1,2,3]" || b["done"] != "[9]" {
		t.Fatalf("alice %v, bob %v", a, b)
	}

	// It is the same on every version.
	call(t, ts, alice, "POST", "/api/pages/"+page+"/versions", `{"html":"<p>todo v2</p>"}`)
	if d := data(alice); d["done"] != "[1,2,3]" {
		t.Fatalf("after v2 = %v", d)
	}

	// Archived, it is out of reach; restored, it is back.
	call(t, ts, alice, "POST", "/api/pages/"+page+"/archive", "")
	expect(alice, "GET", "", http.StatusNotFound)
	call(t, ts, alice, "POST", "/api/pages/"+page+"/unarchive", "")
	if d := data(alice); d["done"] != "[1,2,3]" {
		t.Fatalf("after unarchive = %v", d)
	}

	// Clearing drops only the caller's data.
	expect(bob, "DELETE", "", http.StatusNoContent)
	if a, b := data(alice), data(bob); len(a) != 1 || len(b) != 0 {
		t.Fatalf("after bob's clear: alice %v, bob %v", a, b)
	}

	// Bad requests.
	expect(alice, "PATCH", `{"set":{"":"x"}}`, http.StatusBadRequest)
	expect(alice, "PATCH", `{"set":{"`+strings.Repeat("k", store.MaxPageDataKeyBytes+1)+`":"x"}}`, http.StatusBadRequest)
	expect(alice, "PATCH", `{"set":{"n":1}}`, http.StatusBadRequest)
	expect(carol, "GET", "", http.StatusNotFound)
	if code, _ := call(t, ts, alice, "GET", "/api/pages/not-a-uuid/data", ""); code != http.StatusNotFound {
		t.Fatalf("malformed id: %d", code)
	}
}

func TestPageDataQuota(t *testing.T) {
	ts := newTestServer(t)
	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"Big","html":"<p>big</p>"}`)
	path := "/api/pages/" + createdID(t, code, body) + "/data"

	half := strings.Repeat("x", store.MaxPageDataBytes/2)
	if code, body := call(t, ts, "alice", "PATCH", path, `{"set":{"a":"`+half+`"}}`); code != http.StatusNoContent {
		t.Fatalf("first half: %d %s", code, body)
	}
	// Over the quota, nothing in the change is applied.
	if code, _ := call(t, ts, "alice", "PATCH", path, `{"set":{"b":"`+half+`","c":"small"}}`); code != http.StatusBadRequest {
		t.Fatalf("over quota: %d, want 400", code)
	}
	_, body = call(t, ts, "alice", "GET", path, "")
	var d map[string]string
	mustJSON(t, body, &d)
	if len(d) != 1 {
		t.Fatalf("after refused change: keys %d, want 1", len(d))
	}
	// Replacing a value counts its new size, not both.
	if code, body := call(t, ts, "alice", "PATCH", path, `{"set":{"a":"`+half+`"}}`); code != http.StatusNoContent {
		t.Fatalf("rewrite: %d %s", code, body)
	}
}

func TestWithSDK(t *testing.T) {
	for in, want := range map[string]string{
		"<p>hi</p>":                       sdkTag + "<p>hi</p>",
		"<!DOCTYPE html><html>":           "<!DOCTYPE html>" + sdkTag + "<html>",
		"\n  <!doctype html>\n<html>":     "\n  <!doctype html>" + sdkTag + "\n<html>",
		"\uFEFF<!doctype html><p>x</p>":   "\uFEFF<!doctype html>" + sdkTag + "<p>x</p>",
		"<html><!doctype html>":           sdkTag + "<html><!doctype html>",
		"<!-- c --><!doctype html><html>": "<!-- c --><!doctype html>" + sdkTag + "<html>",
	} {
		if got := withSDK(in); got != want {
			t.Errorf("withSDK(%q) = %q", in, got)
		}
	}
	if strings.Contains(sdkTag, "\n//") || !strings.HasPrefix(sdkTag, "<script>(() => {") {
		t.Fatalf("sdkTag not stripped of comments: %.80q", sdkTag)
	}
}
