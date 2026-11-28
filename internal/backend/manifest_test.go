package backend

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

var bundleFiles = []string{"index.html", ".specola/backend.json", ".specola/server/index.mjs", ".specola/server/chunk.js", "assets/app.js"}

func TestParseManifestDefaults(t *testing.T) {
	m, err := ParseManifest([]byte(`{"version":1}`), bundleFiles)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(m)
	want := `{"version":1,"entry":"server/index.mjs","public":[],"egress":[],"secrets":[],"cron":[],"topics":{"public":[]},"dependencies":{}}`
	if string(b) != want {
		t.Fatalf("normalised = %s\nwant %s", b, want)
	}
}

func TestParseManifestFull(t *testing.T) {
	m, err := ParseManifest([]byte(`{
		"version": 1,
		"entry": "server/chunk.js",
		"public": ["get /api/stats", "POST /api/votes", "GET /api/public/*", "GET /"],
		"egress": ["API.openai.com", "*.googleapis.com", "example.com:443", "plain.example:80"],
		"secrets": ["OPENAI_API_KEY", "A"],
		"cron": [{"name": "nightly", "schedule": "0  3 * * *"}, {"name": "weekdays", "schedule": "*/15 9-17 * JAN-dec mon-FRI"}],
		"topics": {"public": ["scoreboard", "room:1"]},
		"dependencies": {"better-sqlite3": "12.4.1", "@img/sharp-linux-x64": "0.34.4-rc.1+build.2"}
	}`), bundleFiles)
	if err != nil {
		t.Fatal(err)
	}
	want := &Manifest{
		Version: 1, Entry: "server/chunk.js",
		Public:       []string{"GET /api/stats", "POST /api/votes", "GET /api/public/*", "GET /"},
		Egress:       []string{"api.openai.com", "*.googleapis.com", "example.com:443", "plain.example:80"},
		Secrets:      []string{"OPENAI_API_KEY", "A"},
		Cron:         []CronJob{{"nightly", "0 3 * * *"}, {"weekdays", "*/15 9-17 * JAN-dec mon-FRI"}},
		Topics:       Topics{Public: []string{"scoreboard", "room:1"}},
		Dependencies: map[string]string{"better-sqlite3": "12.4.1", "@img/sharp-linux-x64": "0.34.4-rc.1+build.2"},
	}
	if !reflect.DeepEqual(m, want) {
		t.Fatalf("manifest = %+v\nwant %+v", m, want)
	}
}

func TestParseManifestErrors(t *testing.T) {
	tenJobs := `[` + strings.Repeat(`{"name":"j","schedule":"* * * * *"},`, 10) + `{"name":"k","schedule":"* * * * *"}]`
	for name, tc := range map[string]struct{ json, field string }{
		"not json":          {`{`, "not a valid manifest"},
		"two values":        {`{"version":1}{}`, "more than one"},
		"unknown field":     {`{"version":1,"routes":[]}`, `"routes"`},
		"no version":        {`{}`, `"version"`},
		"version 2":         {`{"version":2}`, `"version"`},
		"entry missing":     {`{"version":1,"entry":"server/other.mjs"}`, `"entry"`},
		"entry not js":      {`{"version":1,"entry":"backend.json"}`, `"entry"`},
		"entry absolute":    {`{"version":1,"entry":"/server/index.mjs"}`, `"entry"`},
		"entry prefixed":    {`{"version":1,"entry":".specola/server/index.mjs"}`, `"entry"`},
		"entry dotdot":      {`{"version":1,"entry":"../assets/app.js"}`, `"entry"`},
		"entry empty":       {`{"version":1,"entry":""}`, `"entry"`},
		"route no method":   {`{"version":1,"public":["/api"]}`, `"public"[0]`},
		"route bad method":  {`{"version":1,"public":["FETCH /api"]}`, `"public"[0]`},
		"route relative":    {`{"version":1,"public":["GET api"]}`, `"public"[0]`},
		"route mid star":    {`{"version":1,"public":["GET /a/*/b"]}`, `"public"[0]`},
		"route star prefix": {`{"version":1,"public":["GET /a/b*"]}`, `"public"[0]`},
		"route query":       {`{"version":1,"public":["GET /a?b=1"]}`, `"public"[0]`},
		"route twice":       {`{"version":1,"public":["GET /a","get /a"]}`, `"public"[1]`},
		"route empty seg":   {`{"version":1,"public":["GET /a//b"]}`, `"public"[0]`},
		"egress ipv4":       {`{"version":1,"egress":["10.0.0.1"]}`, `"egress"[0]`},
		"egress ipv6":       {`{"version":1,"egress":["[::1]"]}`, `"egress"[0]`},
		"egress short ip":   {`{"version":1,"egress":["127.1"]}`, `"egress"[0]`},
		"egress hex ip":     {`{"version":1,"egress":["0x7f000001"]}`, `"egress"[0]`},
		"egress port":       {`{"version":1,"egress":["example.com:8080"]}`, `"egress"[0]`},
		"egress mid star":   {`{"version":1,"egress":["api.*.com"]}`, `"egress"[0]`},
		"egress url":        {`{"version":1,"egress":["https://example.com"]}`, `"egress"[0]`},
		"egress empty":      {`{"version":1,"egress":[""]}`, `"egress"[0]`},
		"egress twice":      {`{"version":1,"egress":["a.com","A.com"]}`, `"egress"[1]`},
		"secret lowercase":  {`{"version":1,"secrets":["api_key"]}`, `"secrets"[0]`},
		"secret digit":      {`{"version":1,"secrets":["1KEY"]}`, `"secrets"[0]`},
		"secret too long":   {`{"version":1,"secrets":["` + "A" + strings.Repeat("B", 64) + `"]}`, `"secrets"[0]`},
		"secret twice":      {`{"version":1,"secrets":["A","A"]}`, `"secrets"[1]`},
		"cron too many":     {`{"version":1,"cron":` + tenJobs + `}`, `"cron"`},
		"cron no name":      {`{"version":1,"cron":[{"schedule":"* * * * *"}]}`, `"cron"[0].name`},
		"cron same name":    {`{"version":1,"cron":[{"name":"a","schedule":"* * * * *"},{"name":"a","schedule":"0 * * * *"}]}`, `"cron"[1].name`},
		"cron 6 fields":     {`{"version":1,"cron":[{"name":"a","schedule":"0 * * * * *"}]}`, `"cron"[0].schedule`},
		"cron minute 60":    {`{"version":1,"cron":[{"name":"a","schedule":"60 * * * *"}]}`, `"cron"[0].schedule`},
		"cron hour 24":      {`{"version":1,"cron":[{"name":"a","schedule":"0 24 * * *"}]}`, `"cron"[0].schedule`},
		"cron day 0":        {`{"version":1,"cron":[{"name":"a","schedule":"0 0 0 * *"}]}`, `"cron"[0].schedule`},
		"cron month 13":     {`{"version":1,"cron":[{"name":"a","schedule":"0 0 1 13 *"}]}`, `"cron"[0].schedule`},
		"cron dow 8":        {`{"version":1,"cron":[{"name":"a","schedule":"0 0 * * 8"}]}`, `"cron"[0].schedule`},
		"cron step 0":       {`{"version":1,"cron":[{"name":"a","schedule":"*/0 * * * *"}]}`, `"cron"[0].schedule`},
		"cron backwards":    {`{"version":1,"cron":[{"name":"a","schedule":"0 5-3 * * *"}]}`, `"cron"[0].schedule`},
		"cron bare step":    {`{"version":1,"cron":[{"name":"a","schedule":"5/10 * * * *"}]}`, `"cron"[0].schedule`},
		"cron macro":        {`{"version":1,"cron":[{"name":"a","schedule":"@daily"}]}`, `"cron"[0].schedule`},
		"topics shape":      {`{"version":1,"topics":{"private":[]}}`, `"topics"`},
		"topic bad name":    {`{"version":1,"topics":{"public":["a b"]}}`, `"topics.public"[0]`},
		"dep not object":    {`{"version":1,"dependencies":["a"]}`, "not a valid manifest"},
		"dep range":         {`{"version":1,"dependencies":{"a":"^1.2.3"}}`, `"dependencies" "a"`},
		"dep tag":           {`{"version":1,"dependencies":{"a":"latest"}}`, `"dependencies" "a"`},
		"dep git":           {`{"version":1,"dependencies":{"a":"github:x/y"}}`, `"dependencies" "a"`},
		"dep not string":    {`{"version":1,"dependencies":{"a":1}}`, `"dependencies" "a"`},
		"dep upper name":    {`{"version":1,"dependencies":{"Abc":"1.0.0"}}`, `"dependencies" "Abc"`},
		"dep path name":     {`{"version":1,"dependencies":{"../x":"1.0.0"}}`, `"dependencies" "../x"`},
		"dep first sorted":  {`{"version":1,"dependencies":{"b":"x","a":"y"}}`, `"dependencies" "a"`},
		"too large":         {`{"version":1,"x":"` + strings.Repeat("x", MaxManifestBytes) + `"}`, "larger than"},
	} {
		_, err := ParseManifest([]byte(tc.json), bundleFiles)
		var me *ManifestError
		if !errors.As(err, &me) || !strings.Contains(err.Error(), tc.field) || !strings.HasPrefix(err.Error(), ManifestPath+": ") {
			t.Errorf("%s: err = %v, want a ManifestError naming %s", name, err, tc.field)
		}
	}
}

func TestParseScheduleAccepts(t *testing.T) {
	for _, s := range []string{"* * * * *", "0 3 * * *", "0,30 */2 1-15/3 * 0", "59 23 31 12 7", "0 0 * feb sun", "1-5/2 * * * *"} {
		if _, err := parseSchedule(s); err != nil {
			t.Errorf("%q: %v", s, err)
		}
	}
}

func TestCodeHash(t *testing.T) {
	files := map[string]string{
		"index.html":                "aa",
		".specola/server/index.mjs": "bb",
		".specola/backend.json":     "cc",
		"assets/x.js":               "dd",
	}
	h := sha256.Sum256([]byte("backend.json\tcc\nserver/index.mjs\tbb\n"))
	if got, want := CodeHash(files), hex.EncodeToString(h[:]); got != want {
		t.Fatalf("CodeHash = %s, want %s", got, want)
	}
	files["assets/x.js"] = "ee"
	if CodeHash(files) != hex.EncodeToString(h[:]) {
		t.Fatal("the frontend's files changed the code hash")
	}
}
