package backend

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

// Scheduled jobs (docs/page-backends.md, "Scheduled jobs (step 5)"): specola
// owns the schedule and calls the runner's POST /scheduled when a job is due;
// the runner calls the entry's scheduled(event, ctx).

// ScheduledTimeout is how long a scheduled run may take; the runner stops
// the handler then and answers "timeout".
const ScheduledTimeout = 5 * time.Minute

// scheduledGrace is how much longer than ScheduledTimeout specola waits for
// the runner's answer, which comes after the runner's own deadline.
const scheduledGrace = 30 * time.Second

// Event is the scheduled handler's event: the job's name and the time it was
// due, in milliseconds since the epoch.
type Event struct {
	Name          string `json:"name"`
	ScheduledTime int64  `json:"scheduledTime"`
}

// ScheduledHead is the head of a scheduled run, sent in X-Specola-Invoke
// like an Invoke's, with the event in place of the request. User and Link
// are always nil and Role is "cron".
type ScheduledHead struct {
	Page      Page              `json:"page"`
	VersionID string            `json:"versionId"`
	CodeHash  string            `json:"codeHash"`
	User      *User             `json:"user"`
	Role      string            `json:"role"`
	Link      *Link             `json:"link"`
	Secrets   map[string]string `json:"secrets"`
	Egress    []string          `json:"egress"`
	Event     Event             `json:"event"`
}

// Scheduled run outcomes, as backend_cron.last_status stores them. The
// first four are the runner's answer; Unavailable is specola's, when the
// runner couldn't be reached; Skipped too, when the page is archived.
const (
	CronOK          = "ok"
	CronNoHandler   = "no-handler"
	CronError       = "error"
	CronTimeout     = "timeout"
	CronUnavailable = "unavailable"
	CronSkipped     = "skipped"
)

// ScheduledResult is the outcome of a scheduled run: Status is one of the
// Cron* values; Ref names the log line of an error; Message says what went
// wrong when the runner (rather than the handler) failed.
type ScheduledResult struct {
	Status  string `json:"status"`
	Ref     string `json:"ref,omitempty"`
	Message string `json:"message,omitempty"`
}

// Scheduled asks the runner's POST /scheduled to run a job, and waits for
// its outcome (at most ScheduledTimeout, plus a little). The error is
// non-nil only when the runner gave no answer at all (see Unreachable); an
// error answer of the runner's (X-Specola-Error) is a result.
func (r *Runner) Scheduled(ctx context.Context, head ScheduledHead) (ScheduledResult, error) {
	if head.Secrets == nil {
		head.Secrets = map[string]string{}
	}
	if head.Egress == nil {
		head.Egress = []string{}
	}
	head.User, head.Link, head.Role = nil, nil, "cron"
	b, err := json.Marshal(head)
	if err != nil {
		return ScheduledResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, ScheduledTimeout+scheduledGrace)
	defer cancel()
	req, err := r.newRequest(ctx, http.MethodPost, "/scheduled", http.NoBody)
	if err != nil {
		return ScheduledResult{}, err
	}
	req.Header.Set("X-Specola-Invoke", base64.RawURLEncoding.EncodeToString(b))
	// The answer comes when the job is done, minutes later maybe: the slow
	// client has no header timeout, ctx bounds it.
	res, err := r.slow.Do(req)
	if err != nil {
		return ScheduledResult{}, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return ScheduledResult{}, err
	}
	if code := res.Header.Get("X-Specola-Error"); code != "" || res.StatusCode != http.StatusOK {
		var e struct {
			Error, Message, Ref string
		}
		_ = json.Unmarshal(body, &e)
		if e.Message == "" {
			e.Message = "the runner answered " + res.Status
			if code != "" {
				e.Message += " (" + code + ")"
			}
		}
		status := CronError
		switch code {
		case "backend-timeout":
			status = CronTimeout
		case "backend-unavailable":
			status = CronUnavailable
		}
		return ScheduledResult{Status: status, Ref: e.Ref, Message: e.Message}, nil
	}
	var out ScheduledResult
	if err := json.Unmarshal(body, &out); err != nil {
		return ScheduledResult{}, errors.New("the runner's answer to /scheduled is not JSON")
	}
	switch out.Status {
	case CronOK, CronNoHandler, CronError, CronTimeout:
	default:
		return ScheduledResult{Status: CronError, Message: "the runner answered an unknown status " + out.Status}, nil
	}
	return out, nil
}
