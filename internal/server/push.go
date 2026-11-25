package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"

	"github.com/danieles/specola/internal/store"

	"github.com/go-chi/chi/v5"
)

// Realtime push (docs/page-backends.md, "Realtime push"). A page's backend
// calls ctx.publish(topic, data, {to?}); the runner posts it to
// /internal/runner/publish, and specola sends it on the Postgres channel
// specola_push. Every replica LISTENs on that channel with a connection of
// its own and hands each push to the event streams it holds
// (GET /api/pages/{id}/events, and /p/{token}/events for public links), so a
// push reaches every open page whichever replica it is connected to.
// Delivery is best effort: a stream that is not open, or that falls behind,
// misses the events; nothing is replayed.

const (
	// pushChannel is the NOTIFY channel pushes travel on.
	pushChannel = "specola_push"
	// maxPushData bounds a push's data, serialised: with the rest of the
	// payload it must fit Postgres's NOTIFY limit.
	maxPushData = 7 << 10
	// maxNotifyPayload is Postgres's NOTIFY limit: a payload must be
	// shorter than this many bytes.
	maxNotifyPayload = 8000
	// maxStreamTopics bounds the topics of one event stream.
	maxStreamTopics = 20
	// streamBuffer is how many events a stream may fall behind by; past
	// it, events for that stream are dropped.
	streamBuffer = 64

	// Defaults of pushHub's timings, which tests change.
	defaultHeartbeat    = 25 * time.Second
	defaultAccessRetest = 5 * time.Minute
	defaultVersionPoll  = 10 * time.Second
)

// pushTopic is a valid topic, to publish or subscribe to.
var pushTopic = regexp.MustCompile(`^[A-Za-z0-9_.:/-]{1,128}$`)

// routesPush registers the runner's publish route and the event streams of
// signed-in viewers; on the app router. The public links' streams are in
// routesPublic.
func (s *Server) routesPush(r chi.Router) {
	r.Post("/internal/runner/publish", s.handleRunnerPublish)
	r.With(s.requireAuth).Get("/api/pages/{id}/events", s.handlePageEvents)
}

// pushMessage is a push as the runner posts it and as it travels on the
// channel, with the page's id in its canonical spelling.
type pushMessage struct {
	Page  string          `json:"page"`
	Topic string          `json:"topic"`
	Data  json.RawMessage `json:"data"`
	To    string          `json:"to,omitempty"`
}

// handleRunnerPublish takes a push from the runner and sends it to every
// replica. Only the runner, with its token, may post; anyone else, and
// everyone when backends are disabled, gets 404 as for any /internal/ path.
func (s *Server) handleRunnerPublish(w http.ResponseWriter, r *http.Request) {
	if s.runner == nil || !s.runner.Authorized(r.Header.Get("Authorization")) {
		http.NotFound(w, r)
		return
	}
	var m pushMessage
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		backendError(w, http.StatusRequestEntityTooLarge, "body-too-large", "a push is at most a few KiB")
		return
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		backendError(w, http.StatusBadRequest, "bad-request", `the body must be {"page","topic","data","to"?}`)
		return
	}
	if !pushTopic.MatchString(m.Topic) {
		backendError(w, http.StatusBadRequest, "bad-request", "topic must be 1 to 128 letters, digits, _, ., :, / or -")
		return
	}
	if len(m.Data) == 0 {
		backendError(w, http.StatusBadRequest, "bad-request", "data is required (null is fine)")
		return
	}
	// Compact, so that the size checked is the size sent, and the data is
	// one line in the event stream.
	var data bytes.Buffer
	if err := json.Compact(&data, m.Data); err != nil {
		backendError(w, http.StatusBadRequest, "bad-request", "data must be JSON")
		return
	}
	if data.Len() > maxPushData {
		backendError(w, http.StatusRequestEntityTooLarge, "body-too-large",
			fmt.Sprintf("a push's data is at most %d KiB serialised; this one is %d bytes", maxPushData>>10, data.Len()))
		return
	}
	m.Data = data.Bytes()
	if m.Page, err = s.st.PageID(r.Context(), m.Page); err != nil {
		backendAccessError(w, err)
		return
	}
	payload, err := json.Marshal(m)
	if err != nil {
		backendAccessError(w, err)
		return
	}
	if len(payload) >= maxNotifyPayload {
		// Only a very long topic or recipient gets here, the data being
		// within its limit.
		backendError(w, http.StatusRequestEntityTooLarge, "body-too-large",
			fmt.Sprintf("a push, with its topic and recipient, must be under %d bytes", maxNotifyPayload))
		return
	}
	if err := s.st.Notify(r.Context(), pushChannel, string(payload)); err != nil {
		slog.Error("push: notify", "err", err)
		backendError(w, http.StatusInternalServerError, "internal", "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// streamTopics reads the topics of an event stream: 1 to maxStreamTopics
// valid ones, without duplicates. It answers 400 and returns nil otherwise.
func streamTopics(w http.ResponseWriter, r *http.Request) map[string]bool {
	list := r.URL.Query()["topic"]
	if len(list) == 0 || len(list) > maxStreamTopics {
		backendError(w, http.StatusBadRequest, "bad-request", fmt.Sprintf("name 1 to %d topics, as ?topic=a&topic=b", maxStreamTopics))
		return nil
	}
	topics := make(map[string]bool, len(list))
	for _, t := range list {
		if !pushTopic.MatchString(t) {
			backendError(w, http.StatusBadRequest, "bad-request", fmt.Sprintf("topic %q: 1 to 128 letters, digits, _, ., :, / or -", t))
			return nil
		}
		topics[t] = true
	}
	return topics
}

// streamVersion reads ?v=, the version the frame shows. It answers 400 and
// returns false when it is missing or not a version.
func streamVersion(w http.ResponseWriter, r *http.Request) (int, bool) {
	v, err := strconv.Atoi(r.URL.Query().Get("v"))
	if err != nil || v < 1 {
		backendError(w, http.StatusBadRequest, "bad-request", "v must name the version the page shows")
		return 0, false
	}
	return v, true
}

// handlePageEvents streams the pushes of a page's backend on the topics
// asked, to a signed-in viewer of the page: those for everyone and those
// for them.
func (s *Server) handlePageEvents(w http.ResponseWriter, r *http.Request) {
	ctx, sub, id := r.Context(), subOf(r.Context()), chi.URLParam(r, "id")
	version, ok := streamVersion(w, r)
	if !ok {
		return
	}
	topics := streamTopics(w, r)
	if topics == nil {
		return
	}
	t, err := s.st.BackendTarget(ctx, sub, id)
	if err != nil {
		backendAccessError(w, err)
		return
	}
	if version == t.Version && t.Manifest == nil {
		backendError(w, http.StatusNotFound, "no-backend", "this version of the page has no backend")
		return
	}
	if s.runner == nil {
		backendError(w, http.StatusServiceUnavailable, "backend-disabled", "page backends are not enabled on this instance")
		return
	}
	s.streamEvents(w, r, &subscriber{page: t.ID, version: version, topics: topics, sub: sub},
		version != t.Version, func(ctx context.Context) string {
			t, err := s.st.BackendTarget(ctx, sub, id)
			switch {
			case errors.Is(err, store.ErrNotFound), errors.Is(err, store.ErrForbidden):
				return "forbidden"
			case err != nil:
				// Not an answer about access (the database is down):
				// keep the stream, and ask again next time.
				slog.Warn("push: access re-check", "err", err)
				return ""
			case t.Version != version:
				return "superseded"
			}
			return ""
		})
}

// streamEvents holds an event stream open for sub until the client goes,
// the version it shows stops being current (event superseded) or, as
// recheck says every so often, it can't see the page any more (event
// forbidden). superseded: it already isn't current.
func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request, sub *subscriber, superseded bool, recheck func(context.Context) string) {
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	// Proxies such as nginx buffer responses unless told not to; a stream
	// must reach the client as it is written.
	h.Set("X-Accel-Buffering", "no")
	rc := http.NewResponseController(w)
	if superseded {
		w.WriteHeader(http.StatusOK)
		writeEnd(w, "superseded")
		_ = rc.Flush()
		return
	}

	hub := s.pushHub()
	hub.subscribe(sub)
	defer hub.unsubscribe(sub)
	// The stream opens once pushes reach it (or the listener is slow to
	// connect: it opens anyway, and gets what comes after).
	hub.waitListening(r.Context(), 5*time.Second)
	w.WriteHeader(http.StatusOK)
	if rc.Flush() != nil {
		return
	}

	beat := time.NewTicker(hub.heartbeatEvery())
	defer beat.Stop()
	retest := time.NewTicker(hub.accessEvery())
	defer retest.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case frame := <-sub.events:
			if _, err := w.Write(frame); err != nil || rc.Flush() != nil {
				return
			}
		case reason := <-sub.end:
			writeEnd(w, reason)
			_ = rc.Flush()
			return
		case <-beat.C:
			// A comment: keeps proxies from closing an idle stream.
			if _, err := io.WriteString(w, ": keep-alive\n\n"); err != nil || rc.Flush() != nil {
				return
			}
		case <-retest.C:
			if reason := recheck(r.Context()); reason != "" {
				writeEnd(w, reason)
				_ = rc.Flush()
				return
			}
		}
	}
}

// writeEnd sends the event that ends a stream: superseded or forbidden.
// It has data, as EventSource dispatches no event without.
func writeEnd(w io.Writer, reason string) {
	_, _ = io.WriteString(w, "event: "+reason+"\ndata: {}\n\n")
}

// subscriber is one open event stream.
type subscriber struct {
	page    string // canonical id
	version int    // the version the frame shows
	topics  map[string]bool
	// sub is the viewer's; public is a public-link visitor, who has none
	// and never gets targeted events.
	sub    string
	public bool
	// events carries the frames to write; end, the reason the stream must
	// end, once.
	events  chan []byte
	end     chan string
	endOnce sync.Once
}

func (sub *subscriber) stop(reason string) {
	sub.endOnce.Do(func() { sub.end <- reason })
}

// wants reports whether a push is for this stream.
func (sub *subscriber) wants(m *pushMessage) bool {
	if m.Page != sub.page || !sub.topics[m.Topic] {
		return false
	}
	return m.To == "" || (!sub.public && m.To == sub.sub)
}

// pushHub holds this replica's event streams and the LISTEN connection that
// feeds them. Its zero value is ready to use (Server.push); the listener
// runs while there are streams, so a replica nobody watches holds no
// connection for it.
type pushHub struct {
	// Timings; zero means the default. Tests set them before the first
	// stream.
	heartbeat, accessRetest, versionPoll time.Duration

	st        *store.Store
	mu        sync.Mutex
	subs      map[*subscriber]struct{}
	running   bool
	listening chan struct{} // closed while LISTEN is in effect
}

func (s *Server) pushHub() *pushHub {
	h := &s.push
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.st == nil {
		h.st = s.st
		h.subs = map[*subscriber]struct{}{}
		h.listening = make(chan struct{})
	}
	return h
}

func orDefault(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

func (h *pushHub) heartbeatEvery() time.Duration { return orDefault(h.heartbeat, defaultHeartbeat) }
func (h *pushHub) accessEvery() time.Duration    { return orDefault(h.accessRetest, defaultAccessRetest) }
func (h *pushHub) pollEvery() time.Duration      { return orDefault(h.versionPoll, defaultVersionPoll) }

func (h *pushHub) subscribe(sub *subscriber) {
	sub.events = make(chan []byte, streamBuffer)
	sub.end = make(chan string, 1)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.subs[sub] = struct{}{}
	if !h.running {
		h.running = true
		go h.run()
	}
}

func (h *pushHub) unsubscribe(sub *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subs, sub)
}

// waitListening waits until LISTEN is in effect, at most d.
func (h *pushHub) waitListening(ctx context.Context, d time.Duration) {
	h.mu.Lock()
	ch := h.listening
	h.mu.Unlock()
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ch:
	case <-t.C:
	case <-ctx.Done():
	}
}

// idle reports whether no stream is open, and if so marks the listener
// stopped: the next stream starts another.
func (h *pushHub) idle() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.subs) == 0 {
		h.running = false
		return true
	}
	return false
}

func (h *pushHub) setListening(on bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	select {
	case <-h.listening:
		if !on {
			h.listening = make(chan struct{})
		}
	default:
		if on {
			close(h.listening)
		}
	}
}

// run keeps a connection LISTENing while there are streams, reconnecting
// with backoff (1 s, doubling, at most 30 s) when it is lost.
func (h *pushHub) run() {
	backoff := time.Second
	for {
		if h.idle() {
			return
		}
		err := h.listen()
		h.setListening(false)
		if err == nil {
			continue // no stream left: idle() ends it
		}
		if errors.Is(err, errListenedOK) {
			backoff = time.Second
		}
		slog.Warn("push: listener lost, reconnecting", "err", err, "in", backoff)
		time.Sleep(backoff)
		backoff = min(backoff*2, 30*time.Second)
	}
}

// errListenedOK is listen's error for a connection that worked a while
// before failing: the next attempt starts from the shortest backoff.
var errListenedOK = errors.New("listen connection lost")

// listen opens a connection, LISTENs, and delivers notifications until no
// stream is left (nil) or the connection fails.
func (h *pushHub) listen() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	conn, err := h.st.ListenConn(ctx)
	if err == nil {
		if _, err = conn.Exec(ctx, "LISTEN "+pushChannel); err != nil {
			conn.Close(context.Background())
		}
	}
	cancel()
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	h.setListening(true)

	lastPoll := time.Now()
	for {
		wait, cancel := context.WithTimeout(context.Background(), h.pollEvery())
		n, err := conn.WaitForNotification(wait)
		timedOut := wait.Err() != nil
		cancel()
		switch {
		case err == nil:
			h.deliver(n.Payload)
		case timedOut && !conn.IsClosed():
			// Nothing came: time to look after the streams.
		default:
			return fmt.Errorf("%w: %v", errListenedOK, err)
		}
		if time.Since(lastPoll) >= h.pollEvery() {
			lastPoll = time.Now()
			h.checkVersions()
		}
		if h.count() == 0 {
			return nil
		}
	}
}

func (h *pushHub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subs)
}

// deliver hands a notification to the streams it is for. A stream too far
// behind misses it: delivery is best effort.
func (h *pushHub) deliver(payload string) {
	var m pushMessage
	if err := json.Unmarshal([]byte(payload), &m); err != nil {
		slog.Warn("push: bad payload", "err", err)
		return
	}
	frame, err := json.Marshal(struct {
		Topic string          `json:"topic"`
		Data  json.RawMessage `json:"data"`
	}{m.Topic, m.Data})
	if err != nil {
		return
	}
	frame = append(append([]byte("event: message\ndata: "), frame...), "\n\n"...)
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subs {
		if sub.wants(&m) {
			select {
			case sub.events <- frame:
			default:
			}
		}
	}
}

// checkVersions ends, with superseded, the streams of a version that is no
// longer its page's current one. One query for every page watched.
func (h *pushHub) checkVersions() {
	h.mu.Lock()
	pages := make([]string, 0, len(h.subs))
	seen := map[string]bool{}
	for sub := range h.subs {
		if !seen[sub.page] {
			seen[sub.page] = true
			pages = append(pages, sub.page)
		}
	}
	h.mu.Unlock()
	if len(pages) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	current, err := h.st.CurrentVersions(ctx, pages)
	if err != nil {
		slog.Warn("push: version check", "err", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.subs {
		v, ok := current[sub.page]
		switch {
		case !ok:
			// The page is gone.
			sub.stop("forbidden")
		case v != sub.version:
			sub.stop("superseded")
		}
	}
}
