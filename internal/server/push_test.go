package server

import (
	"bufio"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/danieles/specola/internal/store"
)

// sseEvent is one event read off a stream; comment is set for a comment
// line instead.
type sseEvent struct {
	event, data, comment string
}

// sseStream reads an event stream's events, in order, on a channel.
type sseStream struct {
	res    *http.Response
	events chan sseEvent
	cancel context.CancelFunc
}

// openEvents opens GET path (an events stream) as user ("" for none) and
// reads it in the background.
func openEvents(t *testing.T, ts *httptest.Server, user, path string, h http.Header) *sseStream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "GET", ts.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range h {
		req.Header[k] = v
	}
	if user != "" {
		req.Header.Set(userHeader, user)
	}
	res, err := noGzip.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	s := &sseStream{res: res, events: make(chan sseEvent, 100), cancel: cancel}
	t.Cleanup(func() { cancel(); res.Body.Close() })
	if res.StatusCode != http.StatusOK {
		close(s.events)
		return s
	}
	go func() {
		defer close(s.events)
		sc := bufio.NewScanner(res.Body)
		var ev sseEvent
		for sc.Scan() {
			line := sc.Text()
			switch {
			case line == "":
				if ev != (sseEvent{}) {
					s.events <- ev
				}
				ev = sseEvent{}
			case strings.HasPrefix(line, ":"):
				ev.comment = line
			case strings.HasPrefix(line, "event: "):
				ev.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				ev.data = strings.TrimPrefix(line, "data: ")
			}
		}
	}()
	return s
}

// next returns the stream's next event, skipping comments; ok is false
// when the stream ended first.
func (s *sseStream) next(t *testing.T) (sseEvent, bool) {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case ev, ok := <-s.events:
			if !ok {
				return sseEvent{}, false
			}
			if ev.comment != "" && ev.event == "" && ev.data == "" {
				continue
			}
			return ev, true
		case <-timeout:
			t.Fatal("no event within 5 s")
		}
	}
}

// want checks the stream's next event.
func (s *sseStream) want(t *testing.T, event, data string) {
	t.Helper()
	ev, ok := s.next(t)
	if !ok || ev.event != event || ev.data != data {
		t.Fatalf("got %+v (open %v), want event %q data %s", ev, ok, event, data)
	}
}

// wantEnd checks the stream ends after an event, with nothing after it.
func (s *sseStream) wantEnd(t *testing.T, event string) {
	t.Helper()
	s.want(t, event, "{}")
	if ev, ok := s.next(t); ok {
		t.Fatalf("after %s: %+v", event, ev)
	}
}

// publish posts a push as the runner does and returns the status and body.
func publish(t *testing.T, ts *httptest.Server, token, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", ts.URL+"/internal/runner/publish", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res := mustDo(t, req)
	return res.StatusCode, readBody(t, res)
}

func mustPublish(t *testing.T, ts *httptest.Server, body string) {
	t.Helper()
	if code, b := publish(t, ts, runnerToken, body); code != http.StatusNoContent {
		t.Fatalf("publish %s: %d %s", body, code, b)
	}
}

// fastPush makes a server's streams look after themselves quickly.
func fastPush(s *Server) {
	s.push.heartbeat = 50 * time.Millisecond
	s.push.accessRetest = 50 * time.Millisecond
	s.push.versionPoll = 50 * time.Millisecond
}

func eventsPath(page string, v int, topics ...string) string {
	q := url.Values{"v": {fmt.Sprint(v)}, "topic": topics}
	return "/api/pages/" + page + "/events?" + q.Encode()
}

func TestPushAcrossReplicas(t *testing.T) {
	fr := newFakeRunner(t)
	ts1, s1, pool := newBackendTestServer(t, fr)
	// A second replica on the same database.
	s2 := New(backendConfig(fr.URL), store.New(pool), nil, nil)
	s2.runner.Check(context.Background())
	ts2 := httptest.NewServer(s2)
	t.Cleanup(ts2.Close)
	fastPush(s1)
	fastPush(s2)

	page := publishBackendPage(t, ts1)
	// Bob can view the page.
	call(t, ts1, "bob@example.com", "GET", "/api/me", "")
	if code, body := call(t, ts1, "alice", "PUT", "/api/pages/"+page+"/acl", `{"email":"bob@example.com","role":"viewer"}`); code != http.StatusNoContent {
		t.Fatalf("share: %d %s", code, body)
	}

	h := http.Header{"Accept-Encoding": {"gzip"}}
	alice := openEvents(t, ts2, "alice", eventsPath(page, 1, "orders", "other"), h)
	bob := openEvents(t, ts1, "bob@example.com", eventsPath(page, 1, "orders"), nil)
	for _, s := range []*sseStream{alice, bob} {
		if s.res.StatusCode != http.StatusOK || s.res.Header.Get("Content-Type") != "text/event-stream" ||
			s.res.Header.Get("Content-Encoding") != "" || s.res.Header.Get("Cache-Control") != "no-store" ||
			s.res.Header.Get("X-Accel-Buffering") != "no" {
			t.Fatalf("stream: %d %v", s.res.StatusCode, s.res.Header)
		}
	}

	t.Run("delivered on every replica", func(t *testing.T) {
		// Published through one replica, delivered by both; the page's id
		// in any spelling.
		mustPublish(t, ts1, `{"page":"`+strings.ToUpper(page)+`","topic":"orders","data":{"n": 1,
			"s":"a\nb"}}`)
		alice.want(t, "message", `{"topic":"orders","data":{"n":1,"s":"a\nb"}}`)
		bob.want(t, "message", `{"topic":"orders","data":{"n":1,"s":"a\nb"}}`)
		mustPublish(t, ts2, `{"page":"`+page+`","topic":"other","data":null}`)
		mustPublish(t, ts2, `{"page":"`+page+`","topic":"orders","data":2}`)
		// Bob isn't subscribed to "other".
		alice.want(t, "message", `{"topic":"other","data":null}`)
		alice.want(t, "message", `{"topic":"orders","data":2}`)
		bob.want(t, "message", `{"topic":"orders","data":2}`)
	})

	t.Run("targeted", func(t *testing.T) {
		mustPublish(t, ts1, `{"page":"`+page+`","topic":"orders","data":"for bob","to":"bob@example.com"}`)
		mustPublish(t, ts1, `{"page":"`+page+`","topic":"orders","data":"for alice","to":"alice"}`)
		mustPublish(t, ts1, `{"page":"`+page+`","topic":"orders","data":"all"}`)
		bob.want(t, "message", `{"topic":"orders","data":"for bob"}`)
		bob.want(t, "message", `{"topic":"orders","data":"all"}`)
		alice.want(t, "message", `{"topic":"orders","data":"for alice"}`)
		alice.want(t, "message", `{"topic":"orders","data":"all"}`)
	})

	t.Run("heartbeat", func(t *testing.T) {
		timeout := time.After(5 * time.Second)
		for {
			select {
			case ev := <-alice.events:
				if ev.comment == ": keep-alive" {
					return
				}
				t.Fatalf("event %+v", ev)
			case <-timeout:
				t.Fatal("no heartbeat")
			}
		}
	})

	t.Run("access lost", func(t *testing.T) {
		if code, body := call(t, ts1, "alice", "DELETE", "/api/pages/"+page+"/acl?sub=bob@example.com", ""); code != http.StatusNoContent {
			t.Fatalf("unshare: %d %s", code, body)
		}
		bob.wantEnd(t, "forbidden")
	})

	t.Run("superseded", func(t *testing.T) {
		// An older version than the current one: told at once.
		old := openEvents(t, ts1, "alice", eventsPath(page, 7, "orders"), nil)
		old.wantEnd(t, "superseded")
		// The current one becoming old: told when it happens.
		publishBundle(t, ts1, mintBundle(t, ts1, "alice", `{"kind":"version","id":"`+page+`"}`), backendBundle, "")
		alice.wantEnd(t, "superseded")
	})
}

func TestPushRules(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, _ := newBackendTestServer(t, fr)
	fastPush(s)
	page := publishBackendPage(t, ts)

	t.Run("stream requests", func(t *testing.T) {
		many := make([]string, 21)
		for i := range many {
			many[i] = fmt.Sprint("t", i)
		}
		for path, want := range map[string]int{
			"/api/pages/" + page + "/events?topic=a":                   http.StatusBadRequest, // no v
			"/api/pages/" + page + "/events?v=x&topic=a":               http.StatusBadRequest,
			"/api/pages/" + page + "/events?v=1":                       http.StatusBadRequest, // no topic
			eventsPath(page, 1, many...):                               http.StatusBadRequest,
			eventsPath(page, 1, "a b"):                                 http.StatusBadRequest,
			eventsPath(page, 1, strings.Repeat("a", 129)):              http.StatusBadRequest,
			eventsPath("00000000-0000-0000-0000-000000000000", 1, "a"): http.StatusNotFound,
		} {
			res := openEvents(t, ts, "alice", path, nil).res
			code := map[int]string{400: "bad-request", 404: "not-found"}[want]
			wantBackendError(t, res, want, code)
		}
		// Somebody who can't see the page.
		wantBackendError(t, openEvents(t, ts, "carol", eventsPath(page, 1, "a"), nil).res, http.StatusNotFound, "not-found")
		// Twenty topics, with every allowed character, are fine.
		ok := openEvents(t, ts, "alice", eventsPath(page, 1, append(many[:19], "A-z_0.9:/x")...), nil)
		if ok.res.StatusCode != http.StatusOK {
			t.Fatalf("20 topics: %d", ok.res.StatusCode)
		}
		// Not signed in.
		if res := openEvents(t, ts, "", eventsPath(page, 1, "a"), nil).res; res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("anonymous: %d", res.StatusCode)
		}
	})

	t.Run("no backend", func(t *testing.T) {
		code, body := call(t, ts, "alice", "POST", "/api/pages", `{"name":"Plain","html":"<p>x</p>"}`)
		plain := createdID(t, code, body)
		wantBackendError(t, openEvents(t, ts, "alice", eventsPath(plain, 1, "a"), nil).res, http.StatusNotFound, "no-backend")
	})

	t.Run("publish", func(t *testing.T) {
		big := strings.Repeat("x", maxPushData-2) // with its quotes: exactly the limit
		for _, c := range []struct {
			token, body string
			status      int
			code        string
		}{
			{"wrong-token", `{"page":"` + page + `","topic":"a","data":1}`, http.StatusNotFound, ""},
			{runnerToken, `not json`, http.StatusBadRequest, "bad-request"},
			{runnerToken, `{"page":"` + page + `","topic":"a b","data":1}`, http.StatusBadRequest, "bad-request"},
			{runnerToken, `{"page":"` + page + `","topic":"","data":1}`, http.StatusBadRequest, "bad-request"},
			{runnerToken, `{"page":"` + page + `","topic":"a"}`, http.StatusBadRequest, "bad-request"},
			{runnerToken, `{"page":"00000000-0000-0000-0000-000000000000","topic":"a","data":1}`, http.StatusNotFound, "not-found"},
			{runnerToken, `{"page":"nope","topic":"a","data":1}`, http.StatusNotFound, "not-found"},
			{runnerToken, `{"page":"` + page + `","topic":"a","data":"` + big + `x"}`, http.StatusRequestEntityTooLarge, "body-too-large"},
			// The data within its limit, but not the whole payload.
			{runnerToken, `{"page":"` + page + `","topic":"a","data":"` + big + `","to":"` + strings.Repeat("u", 800) + `"}`, http.StatusRequestEntityTooLarge, "body-too-large"},
			{runnerToken, `{"page":"` + page + `","topic":"a","data":"` + big + `"}`, http.StatusNoContent, ""},
		} {
			code, body := publish(t, ts, c.token, c.body)
			if code != c.status || (c.code != "" && !strings.Contains(body, `"error":"`+c.code+`"`)) {
				t.Errorf("publish %.80s: %d %s, want %d %s", c.body, code, body, c.status, c.code)
			}
		}
	})
}

func TestPushDeliveryOfLargeData(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, _ := newBackendTestServer(t, fr)
	fastPush(s)
	page := publishBackendPage(t, ts)
	st := openEvents(t, ts, "alice", eventsPath(page, 1, "a"), nil)
	big := strings.Repeat("y", maxPushData-2)
	mustPublish(t, ts, `{"page":"`+page+`","topic":"a","data":"`+big+`"}`)
	st.want(t, "message", `{"topic":"a","data":"`+big+`"}`)
}

func TestPushListenerStopsAndRestarts(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, _ := newBackendTestServer(t, fr)
	fastPush(s)
	page := publishBackendPage(t, ts)

	first := openEvents(t, ts, "alice", eventsPath(page, 1, "a"), nil)
	mustPublish(t, ts, `{"page":"`+page+`","topic":"a","data":1}`)
	first.want(t, "message", `{"topic":"a","data":1}`)
	first.cancel()
	// With no stream left, the listener lets its connection go.
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.push.mu.Lock()
		running := s.push.running
		s.push.mu.Unlock()
		if !running {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the listener still runs with no stream")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// The next stream starts it again.
	second := openEvents(t, ts, "alice", eventsPath(page, 1, "a"), nil)
	mustPublish(t, ts, `{"page":"`+page+`","topic":"a","data":2}`)
	second.want(t, "message", `{"topic":"a","data":2}`)
}

func TestPushListenerReconnects(t *testing.T) {
	fr := newFakeRunner(t)
	ts, s, pool := newBackendTestServer(t, fr)
	fastPush(s)
	page := publishBackendPage(t, ts)
	st := openEvents(t, ts, "alice", eventsPath(page, 1, "a"), nil)
	// Kill the listening connection from the server's side.
	if _, err := pool.Exec(context.Background(), `
		SELECT pg_terminate_backend(pid) FROM pg_stat_activity
		WHERE datname = current_database() AND query LIKE 'LISTEN %' AND pid <> pg_backend_pid()`); err != nil {
		t.Fatal(err)
	}
	// Once it is back, pushes flow again.
	deadline := time.Now().Add(10 * time.Second)
	for i := 0; ; i++ {
		mustPublish(t, ts, fmt.Sprintf(`{"page":"%s","topic":"a","data":%d}`, page, i))
		select {
		case ev := <-st.events:
			if ev.event == "message" {
				return
			}
		case <-time.After(300 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatal("no push after the listener lost its connection")
		}
	}
}

func TestStreamPathsAreNotCompressed(t *testing.T) {
	for p, want := range map[string]bool{
		"/api/pages/abc/events": true, "/p/tok/x": true, "/p/tok/x/a": true, "/p/tok/events": true,
		"/p/tok/xy": false, "/p/tok": false, "/s/tok/x": false, "/api/pages/abc/events/x": false,
	} {
		if isBackendCall(p) != want {
			t.Errorf("isBackendCall(%q) = %v", p, !want)
		}
	}
}
