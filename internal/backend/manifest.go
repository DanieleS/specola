// Package backend holds what Specola knows about page backends
// (docs/page-backends.md) without touching the database: the bundle's
// backend manifest (.specola/backend.json) and the client of the runner, the
// separate service that runs the code.
package backend

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

const (
	// Prefix is the reserved bundle directory the backend travels in. Its
	// files are stored like any bundle file but never served to anyone but
	// the runner.
	Prefix = ".specola/"
	// ManifestPath is the backend manifest's path in a bundle; its presence
	// makes the version a backend version.
	ManifestPath = Prefix + "backend.json"
	// DefaultEntry is the entry, relative to Prefix, when the manifest
	// names none: where the plugin builds it.
	DefaultEntry = "server/index.mjs"

	// MaxManifestBytes bounds backend.json, which is stored on the version
	// and read on every call.
	MaxManifestBytes = 64 << 10
	// MaxCronJobs is the most scheduled jobs a page may declare.
	MaxCronJobs = 10
	// maxListEntries bounds each of the manifest's other lists, which are
	// sent along with calls: dozens are plenty.
	maxListEntries = 100
)

// Manifest is a validated backend.json with its defaults filled in, as
// stored in asset_version.backend. Lists are never nil, so the stored JSON
// always has every field.
type Manifest struct {
	Version int       `json:"version"`
	Entry   string    `json:"entry"`
	Public  []string  `json:"public"`
	Egress  []string  `json:"egress"`
	Secrets []string  `json:"secrets"`
	Cron    []CronJob `json:"cron"`
	Topics  Topics    `json:"topics"`
}

// CronJob is one scheduled job: a name the handler sees and a 5-field cron
// schedule in UTC.
type CronJob struct {
	Name     string `json:"name"`
	Schedule string `json:"schedule"`
}

// Topics are the push topics a public-link visitor may subscribe to.
type Topics struct {
	Public []string `json:"public"`
}

// IsBackendPath reports whether a bundle path is under the reserved
// .specola/ directory.
func IsBackendPath(p string) bool { return strings.HasPrefix(p, Prefix) }

// ManifestError is a backend.json that doesn't validate; its message names
// the field.
type ManifestError struct{ Reason string }

func (e *ManifestError) Error() string { return ManifestPath + ": " + e.Reason }

func invalid(format string, args ...any) error {
	return &ManifestError{fmt.Sprintf(format, args...)}
}

var (
	secretName = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	cronName   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)
	topicName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`)
	hostLabel  = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`)
	// methods a public route may name.
	methods = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}
)

// ParseManifest validates backend.json against the bundle it comes in:
// files are the bundle's paths (the entry must be one of them). It returns
// the manifest normalised: defaults filled in, methods upper-cased, hosts
// lower-cased.
func ParseManifest(content []byte, files []string) (*Manifest, error) {
	if len(content) > MaxManifestBytes {
		return nil, invalid("larger than %d bytes", MaxManifestBytes)
	}
	// Fields are pointers or raw so that a missing field (a default) is told
	// apart from a wrong one.
	var raw struct {
		Version *int             `json:"version"`
		Entry   *string          `json:"entry"`
		Public  []string         `json:"public"`
		Egress  []string         `json:"egress"`
		Secrets []string         `json:"secrets"`
		Cron    []CronJob        `json:"cron"`
		Topics  *json.RawMessage `json:"topics"`
	}
	dec := json.NewDecoder(bytes.NewReader(content))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&raw); err != nil {
		return nil, invalid("not a valid manifest: %v", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, invalid("not a valid manifest: more than one JSON value")
	}
	if raw.Version == nil || *raw.Version != 1 {
		return nil, invalid(`"version" must be 1`)
	}
	m := &Manifest{Version: 1, Entry: DefaultEntry,
		Public: []string{}, Egress: []string{}, Secrets: []string{}, Cron: []CronJob{}, Topics: Topics{Public: []string{}}}

	if raw.Entry != nil {
		m.Entry = *raw.Entry
	}
	if err := checkEntry(m.Entry, files); err != nil {
		return nil, err
	}

	if len(raw.Public) > maxListEntries {
		return nil, invalid(`"public" can list at most %d routes`, maxListEntries)
	}
	for i, r := range raw.Public {
		route, err := parseRoute(r)
		if err != nil {
			return nil, invalid(`"public"[%d] %q: %v`, i, r, err)
		}
		if slices.Contains(m.Public, route) {
			return nil, invalid(`"public"[%d] %q is listed twice`, i, r)
		}
		m.Public = append(m.Public, route)
	}

	if len(raw.Egress) > maxListEntries {
		return nil, invalid(`"egress" can list at most %d hosts`, maxListEntries)
	}
	for i, h := range raw.Egress {
		host, err := parseHost(h)
		if err != nil {
			return nil, invalid(`"egress"[%d] %q: %v`, i, h, err)
		}
		if slices.Contains(m.Egress, host) {
			return nil, invalid(`"egress"[%d] %q is listed twice`, i, h)
		}
		m.Egress = append(m.Egress, host)
	}

	if len(raw.Secrets) > maxListEntries {
		return nil, invalid(`"secrets" can list at most %d names`, maxListEntries)
	}
	for i, s := range raw.Secrets {
		if !secretName.MatchString(s) {
			return nil, invalid(`"secrets"[%d] %q: a name is an upper-case letter then up to 63 upper-case letters, digits or _`, i, s)
		}
		if slices.Contains(m.Secrets, s) {
			return nil, invalid(`"secrets"[%d] %q is listed twice`, i, s)
		}
		m.Secrets = append(m.Secrets, s)
	}

	if len(raw.Cron) > MaxCronJobs {
		return nil, invalid(`"cron" can have at most %d jobs`, MaxCronJobs)
	}
	for i, j := range raw.Cron {
		if !cronName.MatchString(j.Name) {
			return nil, invalid(`"cron"[%d].name %q: 1 to 64 letters, digits, _, . or -, starting with a letter or digit`, i, j.Name)
		}
		if slices.ContainsFunc(m.Cron, func(c CronJob) bool { return c.Name == j.Name }) {
			return nil, invalid(`"cron"[%d].name %q is used twice`, i, j.Name)
		}
		sched, err := parseSchedule(j.Schedule)
		if err != nil {
			return nil, invalid(`"cron"[%d].schedule %q: %v`, i, j.Schedule, err)
		}
		m.Cron = append(m.Cron, CronJob{Name: j.Name, Schedule: sched})
	}

	if raw.Topics != nil {
		var t struct {
			Public []string `json:"public"`
		}
		dec := json.NewDecoder(bytes.NewReader(*raw.Topics))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&t); err != nil {
			return nil, invalid(`"topics" must be {"public": [...]}: %v`, err)
		}
		if len(t.Public) > maxListEntries {
			return nil, invalid(`"topics.public" can list at most %d topics`, maxListEntries)
		}
		for i, name := range t.Public {
			if !topicName.MatchString(name) {
				return nil, invalid(`"topics.public"[%d] %q: 1 to 128 letters, digits, _, ., :, / or -, starting with a letter or digit`, i, name)
			}
			if slices.Contains(m.Topics.Public, name) {
				return nil, invalid(`"topics.public"[%d] %q is listed twice`, i, name)
			}
			m.Topics.Public = append(m.Topics.Public, name)
		}
	}
	return m, nil
}

// checkEntry checks the entry: a path relative to .specola/, of a JavaScript
// module the bundle has.
func checkEntry(entry string, files []string) error {
	if entry == "" {
		return invalid(`"entry" is empty`)
	}
	if strings.HasPrefix(entry, "/") || strings.HasPrefix(entry, Prefix) {
		return invalid(`"entry" %q must be relative to .specola/, e.g. %q`, entry, DefaultEntry)
	}
	for _, seg := range strings.Split(entry, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return invalid(`"entry" %q has an empty, "." or ".." segment`, entry)
		}
	}
	if !strings.HasSuffix(entry, ".mjs") && !strings.HasSuffix(entry, ".js") {
		return invalid(`"entry" %q must end in .mjs or .js`, entry)
	}
	if !slices.Contains(files, Prefix+entry) {
		return invalid(`"entry" %q is not in the bundle (expected %s%s)`, entry, Prefix, entry)
	}
	return nil
}

// parseRoute checks a public route, "METHOD /path" where * as the last
// segment matches any rest of the path, and returns it with the method
// upper-cased.
func parseRoute(r string) (string, error) {
	method, p, ok := strings.Cut(strings.TrimSpace(r), " ")
	if !ok {
		return "", errors.New(`must be "METHOD /path"`)
	}
	method = strings.ToUpper(method)
	if !slices.Contains(methods, method) {
		return "", fmt.Errorf("method must be one of %s", strings.Join(methods, ", "))
	}
	if !strings.HasPrefix(p, "/") {
		return "", errors.New("the path must start with /")
	}
	if strings.ContainsAny(p, "?# \t") {
		return "", errors.New("the path can't have a query, a fragment or spaces")
	}
	if p != "/" {
		segs := strings.Split(p[1:], "/")
		for i, seg := range segs {
			switch {
			case seg == "" && i < len(segs)-1, seg == "." || seg == "..":
				return "", errors.New(`the path has an empty, "." or ".." segment`)
			case strings.Contains(seg, "*") && (seg != "*" || i != len(segs)-1):
				return "", errors.New("* may only be the whole last segment")
			}
		}
	}
	return method + " " + p, nil
}

// parseHost checks an egress host: a DNS name, optionally with a leading *.
// for its subdomains and a port of 443 or 80; never an IP address. It
// returns it lower-cased.
func parseHost(h string) (string, error) {
	h = strings.ToLower(strings.TrimSpace(h))
	name, port := h, ""
	if i := strings.LastIndexByte(h, ':'); i >= 0 {
		name, port = h[:i], h[i+1:]
		if port != "443" && port != "80" {
			return "", errors.New("the only ports allowed are 443 and 80")
		}
	}
	bare := strings.TrimPrefix(name, "*.")
	if strings.ContainsAny(bare, "[]:") || net.ParseIP(bare) != nil {
		return "", errors.New("IP addresses are not allowed, only host names")
	}
	if bare == "" || len(bare) > 253 {
		return "", errors.New("not a host name")
	}
	labels := strings.Split(bare, ".")
	for _, l := range labels {
		if !hostLabel.MatchString(l) {
			return "", errors.New("not a host name (letters, digits and -, dot-separated; *. only at the start)")
		}
	}
	// A numeric last label is an IP address in some form (1.2.3, 0x7f.1).
	last := labels[len(labels)-1]
	_, decErr := strconv.ParseUint(last, 10, 64)
	_, hexErr := strconv.ParseUint(strings.TrimPrefix(last, "0x"), 16, 64)
	if decErr == nil || (strings.HasPrefix(last, "0x") && hexErr == nil) {
		return "", errors.New("IP addresses are not allowed, only host names")
	}
	return h, nil
}

// cronFields are the bounds of the five fields of a schedule, with the
// names a field accepts (case-insensitive) mapped to their numbers.
var cronFields = []struct {
	name     string
	min, max int
	names    []string // names[i] is min+i
}{
	{"minute", 0, 59, nil},
	{"hour", 0, 23, nil},
	{"day of month", 1, 31, nil},
	{"month", 1, 12, []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}},
	{"day of week", 0, 7, []string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}},
}

// parseSchedule checks a 5-field cron schedule (minute hour day-of-month
// month day-of-week, in UTC; *, lists, ranges, steps, and month and day
// names) and returns it with its fields separated by single spaces. Five
// fields can't fire more than once a minute, which is the limit.
func parseSchedule(s string) (string, error) {
	fields := strings.Fields(s)
	if len(fields) != 5 {
		return "", errors.New("must have 5 fields: minute hour day-of-month month day-of-week")
	}
	for i, f := range fields {
		spec := cronFields[i]
		for _, part := range strings.Split(f, ",") {
			if err := checkCronPart(part, spec.min, spec.max, spec.names); err != nil {
				return "", fmt.Errorf("%s field %q: %v", spec.name, f, err)
			}
		}
	}
	return strings.Join(fields, " "), nil
}

func checkCronPart(part string, min, max int, names []string) error {
	rng, step, hasStep := strings.Cut(part, "/")
	if hasStep {
		n, err := strconv.Atoi(step)
		if err != nil || n < 1 || n > max-min+1 {
			return fmt.Errorf("step %q must be a number from 1 to %d", step, max-min+1)
		}
	}
	if rng == "*" {
		return nil
	}
	value := func(v string) (int, error) {
		if i := slices.Index(names, strings.ToLower(v)); i >= 0 {
			return min + i, nil
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < min || n > max {
			return 0, fmt.Errorf("%q is not a value from %d to %d", v, min, max)
		}
		return n, nil
	}
	lo, hi, isRange := strings.Cut(rng, "-")
	a, err := value(lo)
	if err != nil {
		return err
	}
	if !isRange {
		if hasStep {
			return errors.New("a step needs * or a range before it")
		}
		return nil
	}
	b, err := value(hi)
	if err != nil {
		return err
	}
	if a > b {
		return fmt.Errorf("range %q goes backwards", rng)
	}
	return nil
}

// CodeHash identifies a version's backend code: the hex sha256 of the lines
// "<path>\t<sha256>\n" of every file under .specola/ (path relative to it),
// sorted by path. files maps bundle paths to their sha256; the others are
// ignored.
func CodeHash(files map[string]string) string {
	var paths []string
	for p := range files {
		if IsBackendPath(p) {
			paths = append(paths, p)
		}
	}
	slices.Sort(paths)
	h := sha256.New()
	for _, p := range paths {
		fmt.Fprintf(h, "%s\t%s\n", strings.TrimPrefix(p, Prefix), files[p])
	}
	return hex.EncodeToString(h.Sum(nil))
}
