package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
)

// Read-only SQL on a page's shared database, for MCP's backend_query
// (docs/page-backends.md, "MCP (step 7)"): the runner opens shared.sqlite
// read-only in a short-lived child process, stops it after 5 s and returns
// at most 1000 rows / 1 MiB. specola has checked access already (owners and
// editors); the page id is the canonical one.

// maxQueryAnswer bounds what is read of the runner's answer: its 1 MiB of
// rows, plus the JSON around them and room for escaping.
const maxQueryAnswer = 4 << 20

// QueryResult is the runner's answer to a query: the result's column names,
// its rows (each value as JSON has it: numbers keep their digits, see
// json.Number), and whether rows were left out to stay within the limits.
type QueryResult struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	Truncated bool     `json:"truncated"`
}

// QueryError is the runner's error answer to a query: its X-Specola-Error
// code (bad-request for SQL that is not one read-only statement or doesn't
// run, backend-timeout past 5 s, …) and message, which tell the caller what
// to fix.
type QueryError struct {
	Status  int
	Code    string
	Message string
}

func (e *QueryError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return fmt.Sprintf("the runner answered %d %s", e.Status, e.Code)
}

// Query runs one read-only statement with params on page's shared
// database, through the runner's POST /pages/{id}/query. An error answer of
// the runner's is a *QueryError; any other error means the runner gave no
// answer (see Unreachable).
func (r *Runner) Query(ctx context.Context, pageID, sql string, params []any) (QueryResult, error) {
	if params == nil {
		// The runner reads params as an array: never null.
		params = []any{}
	}
	res, err := r.dataJSON(ctx, quickCall, http.MethodPost, "/pages/"+url.PathEscape(pageID)+"/query",
		map[string]any{"sql": sql, "params": params})
	if err != nil {
		return QueryResult{}, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxQueryAnswer+1))
	if err != nil {
		return QueryResult{}, err
	}
	if code := res.Header.Get("X-Specola-Error"); code != "" || res.StatusCode != http.StatusOK {
		var e struct{ Error, Message string }
		_ = json.Unmarshal(body, &e)
		if code == "" {
			code = e.Error
		}
		return QueryResult{}, &QueryError{Status: res.StatusCode, Code: code, Message: e.Message}
	}
	if len(body) > maxQueryAnswer {
		return QueryResult{}, errors.New("the runner's answer to a query is too large")
	}
	// Numbers stay json.Number: an INTEGER column holds 64-bit values that
	// a float64 would round.
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var out QueryResult
	if err := dec.Decode(&out); err != nil {
		return QueryResult{}, errors.New("the runner's answer to a query is not JSON")
	}
	if out.Columns == nil {
		out.Columns = []string{}
	}
	if out.Rows == nil {
		out.Rows = [][]any{}
	}
	return out, nil
}
