package backend

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRunnerQuery(t *testing.T) {
	var got struct {
		path, auth, ctype string
		body              map[string]any
	}
	answer := func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"columns":["id","n"],"rows":[[9007199254740993,"a"],[1.5,null]],"truncated":true}`)
	}
	rs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path, got.auth, got.ctype = r.URL.EscapedPath(), r.Header.Get("Authorization"), r.Header.Get("Content-Type")
		got.body = nil
		_ = json.NewDecoder(r.Body).Decode(&got.body)
		switch got.body["sql"] {
		case "bad":
			w.Header().Set("X-Specola-Error", "bad-request")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"error":"bad-request","message":"only one read-only statement"}`)
		case "slow":
			w.Header().Set("X-Specola-Error", "backend-timeout")
			w.WriteHeader(http.StatusGatewayTimeout)
		case "empty":
			io.WriteString(w, `{"columns":[],"rows":[],"truncated":false}`)
		case "garbage":
			io.WriteString(w, `<html>`)
		default:
			answer(w)
		}
	}))
	defer rs.Close()
	r := NewRunner(rs.URL, "tok")
	ctx := context.Background()

	res, err := r.Query(ctx, "p/1", "SELECT 1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.path != "/pages/p%2F1/query" || got.auth != "Bearer tok" || got.ctype != "application/json" {
		t.Fatalf("request %+v", got)
	}
	if params, ok := got.body["params"].([]any); !ok || len(params) != 0 || got.body["sql"] != "SELECT 1" {
		t.Fatalf("body %v: params must be an array, never null", got.body)
	}
	if strings.Join(res.Columns, ",") != "id,n" || len(res.Rows) != 2 || !res.Truncated {
		t.Fatalf("result %+v", res)
	}
	// A 64-bit integer keeps its digits.
	if n, ok := res.Rows[0][0].(json.Number); !ok || n.String() != "9007199254740993" {
		t.Fatalf("rows[0][0] = %#v", res.Rows[0][0])
	}
	if res.Rows[1][1] != nil {
		t.Fatalf("rows[1][1] = %#v", res.Rows[1][1])
	}

	if _, err := r.Query(ctx, "p", "SELECT ?", []any{1, "x"}); err != nil {
		t.Fatal(err)
	}
	if b, _ := json.Marshal(got.body["params"]); string(b) != `[1,"x"]` {
		t.Fatalf("params %s", b)
	}

	_, err = r.Query(ctx, "p", "bad", nil)
	var qe *QueryError
	if !errors.As(err, &qe) || qe.Status != 400 || qe.Code != "bad-request" || err.Error() != "only one read-only statement" {
		t.Fatalf("bad SQL: %#v", err)
	}
	_, err = r.Query(ctx, "p", "slow", nil)
	if !errors.As(err, &qe) || qe.Code != "backend-timeout" || !strings.Contains(err.Error(), "504") {
		t.Fatalf("timeout: %#v", err)
	}
	if res, err := r.Query(ctx, "p", "empty", nil); err != nil || res.Columns == nil || res.Rows == nil {
		t.Fatalf("empty: %+v %v", res, err)
	}
	if _, err := r.Query(ctx, "p", "garbage", nil); err == nil || errors.As(err, &qe) {
		t.Fatalf("garbage: %v", err)
	}

	rs.Close()
	// A new client: the old one's idle connection would fail otherwise.
	if _, err := NewRunner(rs.URL, "tok").Query(ctx, "p", "SELECT 1", nil); err == nil || !Unreachable(err) {
		t.Fatalf("closed runner: %v", err)
	}
}
