package mcpserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/danieles/specola/internal/backend"
	"github.com/danieles/specola/internal/store"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// The backend tools (docs/page-backends.md, "MCP (step 7)"): an agent tests
// the backend it published, as its user, with the same access rules as the
// API: call it, read its log, query its shared database, see which secrets
// are missing. There is no tool to set a secret: a value typed to an agent
// would go through the model's context, so owners set them in the UI.

// CallBackendFunc calls the current version of a page's backend as sub,
// exactly as the viewer's /api/pages/{id}/x{path} would for that user
// (server.CallBackendAs). A page sub can't see is the store's error; any
// other answer, specola's own errors included, is a response whose body
// the caller closes.
type CallBackendFunc func(ctx context.Context, sub, pageID, method, path string, headers [][2]string, body []byte) (*http.Response, error)

// maxToolBody is how much of a backend's answer call_backend returns.
const maxToolBody = 64 << 10

const (
	callBackendDesc  = `Call a page's backend as the user, exactly as the page's specola.fetch would from the current version: same access rules, limits and header rules, the handler sees ctx.user and ctx.role of the user. To test what you published. path starts with / and may carry a query; body is sent as UTF-8 text (set a content-type header for it). Returns the status, the response headers and at most 64 KiB of body (truncated says whether there was more): as text when it is text, else base64 (body_encoding). Errors that specola or the runner produce, rather than the handler, carry an x-specola-error header and a JSON body.`
	backendLogsDesc  = `Read a page's backend log: console output, uncaught errors with their stack (an error answer's ref names its line), egress refusals, crashes and scheduled-job outcomes, oldest first, at most 1000 recent lines kept in memory. Owners and editors only. Pass since (the seq of the last line you have) to get only newer lines.`
	backendQueryDesc = `Run one read-only SQL statement (SQLite) on a page backend's shared database (ctx.db), to check what its code wrote. Owners and editors only. params bind to ? placeholders. Returns at most 1000 rows and 1 MiB (truncated says whether rows were left out); stopped after 5 s. Integers beyond ±2^53 come back as strings of their digits, to keep them exact. Users' private databases (ctx.userDb) can't be read this way.`
	listSecretsDesc  = `List a page backend's secrets: every name its current version declares, and any set but no longer declared, with whether each has a value and when it was set; never a value. Owners and editors only. Values are set only by the page's owners, in the page's Backend panel in Specola: there is no tool to set one, so tell the user which are missing rather than asking for a value.`
)

// secretsNote goes with list_secrets' result.
const secretsNote = `Values are never shown. Only the page's owners set them, in the page's Backend panel in Specola (not through MCP, so a secret never passes through the conversation): ask the user to set the missing ones there. The backend reads them from ctx.secrets, on the next call.`

// noBackendError is what the backend tools answer for a page whose current
// version has no backend.
var noBackendError = errors.New("this page has no backend: its current version is not a bundle with server code (.specola/backend.json)")

// runnerDownError is what they answer when the runner can't be reached.
var runnerDownError = errors.New("the backend runner is not available right now; try again later")

// registerBackendTools adds the backend tools: only on an instance with
// backends, where they can do something.
func (t *tools) registerBackendTools(srv *mcp.Server) {
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true}
	// A call runs the page's code, which may write, delete or reach the
	// hosts its manifest allows.
	mcp.AddTool(srv, &mcp.Tool{Name: "call_backend", Description: callBackendDesc,
		Annotations: &mcp.ToolAnnotations{DestructiveHint: ptr(true), OpenWorldHint: ptr(true)}}, t.callBackend)
	mcp.AddTool(srv, &mcp.Tool{Name: "backend_logs", Description: backendLogsDesc, Annotations: readOnly}, t.backendLogs)
	mcp.AddTool(srv, &mcp.Tool{Name: "backend_query", Description: backendQueryDesc, Annotations: readOnly}, t.backendQuery)
	mcp.AddTool(srv, &mcp.Tool{Name: "list_secrets", Description: listSecretsDesc, Annotations: readOnly}, t.listSecrets)
}

// backendTarget is the page id's backend for sub, who must have at least
// role min on it; an error an agent can act on otherwise.
func (t *tools) backendTarget(ctx context.Context, sub, id string, min store.Role) (*store.BackendTarget, error) {
	bt, err := t.st.BackendTarget(ctx, sub, id)
	if err != nil {
		return nil, toolError(err, "page")
	}
	if bt.Role < min {
		return nil, errors.New("only the page's owners and editors can do that")
	}
	if bt.Manifest == nil {
		return nil, noBackendError
	}
	return bt, nil
}

// runnerFailed turns a runner call's error into one an agent can act on,
// marking the runner unavailable when it couldn't be reached.
func (t *tools) runnerFailed(err error) error {
	if t.opts.Runner == nil {
		return errors.New("page backends are not enabled on this instance")
	}
	if backend.Unreachable(err) {
		t.opts.Runner.MarkUnavailable()
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return runnerDownError
}

type callBackendIn struct {
	ID      string            `json:"id" jsonschema:"id of the page"`
	Method  string            `json:"method,omitempty" jsonschema:"GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS; GET when omitted"`
	Path    string            `json:"path" jsonschema:"path starting with /, with any query, as the page would pass it to specola.fetch"`
	Body    string            `json:"body,omitempty" jsonschema:"request body, as UTF-8 text"`
	Headers map[string]string `json:"headers,omitempty" jsonschema:"request headers the page would set, e.g. {\"content-type\": \"application/json\"}"`
}

type callBackendOut struct {
	Status       int               `json:"status"`
	Headers      map[string]string `json:"headers" jsonschema:"response headers, names in lower case"`
	Body         string            `json:"body"`
	BodyEncoding string            `json:"body_encoding" jsonschema:"utf-8 when body is the text as it is, base64 otherwise"`
	Truncated    bool              `json:"truncated" jsonschema:"the body was longer than 64 KiB and is cut there"`
}

// callMethods are the methods call_backend sends, as a page's routes may
// name them.
var callMethods = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}

func (t *tools) callBackend(ctx context.Context, req *mcp.CallToolRequest, in callBackendIn) (*mcp.CallToolResult, callBackendOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, callBackendOut{}, err
	}
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if method == "" {
		method = http.MethodGet
	}
	if !slices.Contains(callMethods, method) {
		return nil, callBackendOut{}, errors.New("method must be one of " + strings.Join(callMethods, ", "))
	}
	if !strings.HasPrefix(in.Path, "/") {
		return nil, callBackendOut{}, errors.New("path must start with /, as specola.fetch's")
	}
	if (method == http.MethodGet || method == http.MethodHead) && in.Body != "" {
		return nil, callBackendOut{}, errors.New("a GET or HEAD request can't have a body")
	}
	if t.opts.CallBackend == nil {
		return nil, callBackendOut{}, errors.New("page backends are not enabled on this instance")
	}
	// Sorted, so that the same call sends the same headers in the same order.
	names := make([]string, 0, len(in.Headers))
	for k := range in.Headers {
		names = append(names, k)
	}
	slices.Sort(names)
	headers := make([][2]string, 0, len(names))
	for _, k := range names {
		headers = append(headers, [2]string{k, in.Headers[k]})
	}
	var body []byte
	if in.Body != "" {
		body = []byte(in.Body)
	}
	res, err := t.opts.CallBackend(ctx, who.Sub, in.ID, method, in.Path, headers, body)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) || errors.Is(err, store.ErrForbidden) {
			return nil, callBackendOut{}, toolError(err, "page")
		}
		return nil, callBackendOut{}, err
	}
	// Closing the body ends the call: a stream longer than the cap stops
	// there, on the runner too.
	defer res.Body.Close()
	if res.Header.Get("X-Specola-Error") == "no-backend" {
		return nil, callBackendOut{}, noBackendError
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxToolBody+1))
	if err != nil {
		return nil, callBackendOut{}, fmt.Errorf("the backend's answer was cut short after %d bytes (status %d): %v", len(b), res.StatusCode, err)
	}
	out := callBackendOut{Status: res.StatusCode, Headers: map[string]string{}}
	if len(b) > maxToolBody {
		b, out.Truncated = b[:maxToolBody], true
	}
	for k, vs := range res.Header {
		out.Headers[strings.ToLower(k)] = strings.Join(vs, ", ")
	}
	out.Body, out.BodyEncoding = encodeBody(b, res.Header.Get("Content-Type"), out.Truncated)
	return nil, out, nil
}

// encodeBody is a response body for an agent: the text as it is when the
// content type says text and the bytes are valid UTF-8, base64 otherwise.
// A body cut at the cap may end inside a character; that partial character
// doesn't make the text binary.
func encodeBody(b []byte, contentType string, truncated bool) (string, string) {
	if len(b) == 0 {
		return "", "utf-8"
	}
	text := b
	if truncated {
		// At most 3 bytes of an incomplete character at the end.
		for i := 0; i < utf8.UTFMax-1 && len(text) > 0 && !utf8.Valid(text); i++ {
			text = text[:len(text)-1]
		}
	}
	if isTextType(contentType) && utf8.Valid(text) {
		return string(text), "utf-8"
	}
	return base64.StdEncoding.EncodeToString(b), "base64"
}

// isTextType reports whether a content type is text: text/*, JSON, XML,
// JavaScript, form data, and their +json / +xml variants.
func isTextType(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	if strings.HasPrefix(mt, "text/") || strings.HasSuffix(mt, "+json") || strings.HasSuffix(mt, "+xml") {
		return true
	}
	switch mt {
	case "application/json", "application/xml", "application/javascript", "application/ecmascript",
		"application/x-www-form-urlencoded", "application/x-ndjson", "application/ndjson",
		"application/graphql", "application/sql", "application/yaml", "application/x-yaml", "image/svg+xml":
		return true
	}
	return false
}

type backendLogsIn struct {
	ID    string `json:"id" jsonschema:"id of the page"`
	Since *int64 `json:"since,omitempty" jsonschema:"only lines after this seq; all kept lines when omitted"`
}

// logLine is a line of the backend log, as the runner's GET /logs has it.
type logLine struct {
	Seq   int64  `json:"seq"`
	Time  string `json:"time"`
	Level string `json:"level" jsonschema:"log, info, warn or error"`
	Text  string `json:"text"`
	Ref   string `json:"ref,omitempty" jsonschema:"set on an uncaught error: the ref of the backend-error answer it caused"`
}

type backendLogsOut struct {
	Lines []logLine `json:"lines" jsonschema:"oldest first"`
}

func (t *tools) backendLogs(ctx context.Context, req *mcp.CallToolRequest, in backendLogsIn) (*mcp.CallToolResult, backendLogsOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, backendLogsOut{}, err
	}
	since := ""
	if in.Since != nil {
		if *in.Since < 0 {
			return nil, backendLogsOut{}, errors.New("since must be a log line's seq")
		}
		since = strconv.FormatInt(*in.Since, 10)
	}
	bt, err := t.backendTarget(ctx, who.Sub, in.ID, store.RoleEditor)
	if err != nil {
		return nil, backendLogsOut{}, err
	}
	if t.opts.Runner == nil {
		return nil, backendLogsOut{}, errors.New("page backends are not enabled on this instance")
	}
	res, err := t.opts.Runner.Logs(ctx, bt.ID, since)
	if err != nil {
		return nil, backendLogsOut{}, t.runnerFailed(err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	if err != nil {
		return nil, backendLogsOut{}, t.runnerFailed(err)
	}
	if res.StatusCode != http.StatusOK {
		return nil, backendLogsOut{}, runnerAnswerError(res, raw)
	}
	out := backendLogsOut{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, backendLogsOut{}, errors.New("the backend runner's log is not JSON")
	}
	if out.Lines == nil {
		out.Lines = []logLine{}
	}
	return nil, out, nil
}

// runnerAnswerError is an error answer of the runner's, as an error with
// its message.
func runnerAnswerError(res *http.Response, raw []byte) error {
	var e struct{ Error, Message string }
	_ = json.Unmarshal(raw, &e)
	if e.Message != "" {
		return errors.New(e.Message)
	}
	return fmt.Errorf("the backend runner answered %s", res.Status)
}

type backendQueryIn struct {
	ID     string `json:"id" jsonschema:"id of the page"`
	SQL    string `json:"sql" jsonschema:"one read-only SQLite statement (SELECT, WITH, read-only PRAGMA)"`
	Params []any  `json:"params,omitempty" jsonschema:"values for the statement's ? placeholders, in order"`
}

func (t *tools) backendQuery(ctx context.Context, req *mcp.CallToolRequest, in backendQueryIn) (*mcp.CallToolResult, backend.QueryResult, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, backend.QueryResult{}, err
	}
	if strings.TrimSpace(in.SQL) == "" {
		return nil, backend.QueryResult{}, errors.New("sql is required")
	}
	bt, err := t.backendTarget(ctx, who.Sub, in.ID, store.RoleEditor)
	if err != nil {
		return nil, backend.QueryResult{}, err
	}
	if t.opts.Runner == nil {
		return nil, backend.QueryResult{}, errors.New("page backends are not enabled on this instance")
	}
	res, err := t.opts.Runner.Query(ctx, bt.ID, in.SQL, in.Params)
	if err != nil {
		var qe *backend.QueryError
		if errors.As(err, &qe) {
			switch qe.Code {
			case "backend-timeout":
				return nil, backend.QueryResult{}, errors.New("the query took longer than 5 s and was stopped")
			case "backend-unavailable":
				return nil, backend.QueryResult{}, runnerDownError
			}
			return nil, backend.QueryResult{}, qe
		}
		return nil, backend.QueryResult{}, t.runnerFailed(err)
	}
	for _, row := range res.Rows {
		for i, v := range row {
			row[i] = exactValue(v)
		}
	}
	return nil, res, nil
}

// maxExactInt is the largest integer a float64 holds exactly (2^53).
const maxExactInt = 1 << 53

// exactValue keeps an integer column's value exact through the MCP SDK,
// which reads a tool's result back as generic JSON (float64) before sending
// it: beyond ±2^53 it is sent as a string of its digits instead.
func exactValue(v any) any {
	n, ok := v.(json.Number)
	if !ok {
		return v
	}
	if i, err := strconv.ParseInt(string(n), 10, 64); err == nil && (i > maxExactInt || i < -maxExactInt) {
		return string(n)
	}
	return n
}

type listSecretsOut struct {
	Secrets []store.SecretInfo `json:"secrets" jsonschema:"by name; declared: the current version names it; set: it has a value"`
	Missing []string           `json:"missing" jsonschema:"declared names without a value: the backend gets no such ctx.secrets entry until an owner sets it"`
	Note    string             `json:"note"`
}

func (t *tools) listSecrets(ctx context.Context, req *mcp.CallToolRequest, in pageIDIn) (*mcp.CallToolResult, listSecretsOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, listSecretsOut{}, err
	}
	if _, err := t.backendTarget(ctx, who.Sub, in.ID, store.RoleEditor); err != nil {
		return nil, listSecretsOut{}, err
	}
	secrets, err := t.st.ListPageSecrets(ctx, who.Sub, in.ID)
	if err != nil {
		return nil, listSecretsOut{}, toolError(err, "page")
	}
	out := listSecretsOut{Secrets: secrets, Missing: []string{}, Note: secretsNote}
	if out.Secrets == nil {
		out.Secrets = []store.SecretInfo{}
	}
	for _, s := range secrets {
		if s.Declared && !s.Set {
			out.Missing = append(out.Missing, s.Name)
		}
	}
	return nil, out, nil
}

// pageBackend is what get_page tells about the current version's backend.
type pageBackend struct {
	Manifest       *backend.Manifest `json:"manifest" jsonschema:"the version's .specola/backend.json, normalised"`
	SecretsMissing []string          `json:"secrets_missing,omitzero" jsonschema:"declared secrets without a value (told to owners and editors): an owner sets them in the page's Backend panel"`
}

// pageBackend describes page id's current backend for sub; nil when the
// current version has none.
func (t *tools) pageBackend(ctx context.Context, sub, id string) (*pageBackend, error) {
	bt, err := t.st.BackendTarget(ctx, sub, id)
	if err != nil {
		return nil, err
	}
	if bt.Manifest == nil {
		return nil, nil
	}
	pb := &pageBackend{Manifest: bt.Manifest}
	// As GET /api/pages/{id}'s backendSecretsMissing: for those who can
	// change the page.
	if bt.Role >= store.RoleEditor {
		if pb.SecretsMissing, err = t.st.MissingPageSecrets(ctx, bt.ID); err != nil {
			return nil, err
		}
	}
	return pb, nil
}
