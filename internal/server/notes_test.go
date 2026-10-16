package server

import (
	"net/http"
	"strings"
	"testing"
)

func TestVersionNotes(t *testing.T) {
	ts := newTestServer(t)
	code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"P","html":"<p>v1</p>","note":"first draft"}`)
	id := createdID(t, code, body)
	add := func(req string) {
		t.Helper()
		if code, body := call(t, ts, "alice", "POST", "/api/pages/"+id+"/versions", req); code != http.StatusCreated {
			t.Fatalf("add version %s: %d %s", req, code, body)
		}
	}
	add(`{"html":"<p>v2</p>","note":"  added October  "}`)
	add(`{"html":"<p>v3</p>","note":"   "}`)
	add(`{"restoreFrom":1,"note":"back to the draft"}`)

	// Too long: refused, and no version is added.
	long := strings.Repeat("é", 501)
	if code, body := call(t, ts, "alice", "POST", "/api/pages/"+id+"/versions", `{"html":"<p>v5</p>","note":"`+long+`"}`); code != http.StatusBadRequest {
		t.Fatalf("long note: %d %s, want 400", code, body)
	}
	if code, _ := call(t, ts, "alice", "POST", "/api/pages/"+id+"/versions", `{"html":"<p>v5</p>","note":"`+long[:len(long)-2]+`"}`); code != http.StatusCreated {
		t.Fatalf("500-character note: %d, want 201", code)
	}

	_, body = call(t, ts, "alice", "GET", "/api/pages/"+id+"/versions", "")
	var vs []struct {
		Version      int
		Note         *string
		RestoredFrom *int
	}
	mustJSON(t, body, &vs)
	if len(vs) != 5 {
		t.Fatalf("versions = %s", body)
	}
	want := map[int]string{4: "back to the draft", 2: "added October", 1: "first draft"}
	for _, v := range vs {
		switch {
		case v.Version == 5:
			if v.Note == nil || len([]rune(*v.Note)) != 500 {
				t.Fatalf("v5 note not kept whole")
			}
		case want[v.Version] == "":
			if v.Note != nil {
				t.Fatalf("v%d: note %q, want none", v.Version, *v.Note)
			}
		case v.Note == nil || *v.Note != want[v.Version]:
			t.Fatalf("v%d: note %v, want %q", v.Version, v.Note, want[v.Version])
		}
	}
	if vs[1].Version != 4 || vs[1].RestoredFrom == nil || *vs[1].RestoredFrom != 1 {
		t.Fatalf("restore lost its origin: %+v", vs[1])
	}
}
