package backend

import (
	"slices"
	"strconv"
	"strings"
	"time"
)

// Schedules (docs/page-backends.md, "Scheduled jobs"): the five-field cron
// schedules a manifest declares, which ParseManifest has already validated
// (parseSchedule), expanded here into the set of values each field allows so
// that the next run can be computed. Times are UTC.
//
// The semantics are those of the standard (Vixie) cron:
//   - a field is a list of parts, each *, a value, a range a-b, or * or a range
//     followed by /step;
//   - day of week 0 and 7 are both Sunday; month and day names are accepted;
//   - when both day of month and day of week are restricted (neither starts
//     with *), a day matches when EITHER matches ("0 0 1 * mon" is the 1st of
//     every month and every Monday); when one of them starts with *, only the
//     other one counts.

// Cron is a parsed schedule.
type Cron struct {
	minute, hour, dom, month, dow uint64 // bit i set: value i allowed
	// domStar and dowStar: the field starts with *, so it doesn't restrict
	// the day on its own (see the OR rule above).
	domStar, dowStar bool
}

// ParseCron parses a five-field schedule, as validated in a manifest.
func ParseCron(s string) (*Cron, error) {
	norm, err := parseSchedule(s)
	if err != nil {
		return nil, err
	}
	fields := strings.Fields(norm)
	var sets [5]uint64
	for i, f := range fields {
		spec := cronFields[i]
		for _, part := range strings.Split(f, ",") {
			sets[i] |= expandCronPart(part, spec.min, spec.max, spec.names)
		}
	}
	c := &Cron{minute: sets[0], hour: sets[1], dom: sets[2], month: sets[3], dow: sets[4],
		domStar: strings.HasPrefix(fields[2], "*"), dowStar: strings.HasPrefix(fields[4], "*")}
	// 7 is another name for Sunday.
	if c.dow&(1<<7) != 0 {
		c.dow |= 1
	}
	return c, nil
}

// expandCronPart is the set of values one part of a field allows. The part
// has been checked by checkCronPart, so it parses.
func expandCronPart(part string, min, max int, names []string) uint64 {
	rng, step, hasStep := strings.Cut(part, "/")
	by := 1
	if hasStep {
		by, _ = strconv.Atoi(step)
	}
	value := func(v string) int {
		if i := slices.Index(names, strings.ToLower(v)); i >= 0 {
			return min + i
		}
		n, _ := strconv.Atoi(v)
		return n
	}
	lo, hi := min, max
	if rng != "*" {
		a, b, isRange := strings.Cut(rng, "-")
		lo = value(a)
		hi = lo
		if isRange {
			hi = value(b)
		}
	}
	var set uint64
	for v := lo; v <= hi; v += by {
		set |= 1 << v
	}
	return set
}

func has(set uint64, v int) bool { return set&(1<<v) != 0 }

// dayMatches applies the day-of-month / day-of-week rule to t's day.
func (c *Cron) dayMatches(t time.Time) bool {
	dom, dow := has(c.dom, t.Day()), has(c.dow, int(t.Weekday()))
	if c.domStar || c.dowStar {
		return dom && dow
	}
	return dom || dow
}

// cronHorizon bounds the search for the next run. Every valid schedule that
// fires at all fires within any 28 years (the Gregorian calendar repeats its
// weekdays every 28 years between century exceptions), and one that names a
// day no month has (31 February) never fires.
const cronHorizon = 29 * 366 * 24 * time.Hour

// Next returns the first time after t, to the minute, at which the schedule
// fires, in UTC; ok is false when it never does (a day like 30 February).
func (c *Cron) Next(t time.Time) (next time.Time, ok bool) {
	t = t.UTC().Truncate(time.Minute).Add(time.Minute)
	end := t.Add(cronHorizon)
	for t.Before(end) {
		switch {
		case !has(c.month, int(t.Month())):
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, time.UTC)
		case !c.dayMatches(t):
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, time.UTC)
		case !has(c.hour, t.Hour()):
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour()+1, 0, 0, 0, time.UTC)
		case !has(c.minute, t.Minute()):
			t = t.Add(time.Minute)
		default:
			return t, true
		}
	}
	return time.Time{}, false
}

// NextRun is Next for a schedule as text; ok is false when the schedule is
// invalid or never fires.
func NextRun(schedule string, after time.Time) (time.Time, bool) {
	c, err := ParseCron(schedule)
	if err != nil {
		return time.Time{}, false
	}
	return c.Next(after)
}
