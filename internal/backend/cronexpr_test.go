package backend

import (
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04", s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestCronNext(t *testing.T) {
	for _, tc := range []struct {
		schedule, after, want string
	}{
		// Every minute: the next minute, never the same one.
		{"* * * * *", "2026-03-01 10:00", "2026-03-01 10:01"},
		{"* * * * *", "2026-12-31 23:59", "2027-01-01 00:00"},
		// Seconds are dropped: "after 10:00:30" is 10:01.
		{"0 3 * * *", "2026-03-01 02:59", "2026-03-01 03:00"},
		{"0 3 * * *", "2026-03-01 03:00", "2026-03-02 03:00"},
		{"0 3 * * *", "2026-03-31 03:00", "2026-04-01 03:00"},
		// Steps, ranges with steps, lists.
		{"*/15 * * * *", "2026-03-01 10:14", "2026-03-01 10:15"},
		{"*/15 * * * *", "2026-03-01 10:45", "2026-03-01 11:00"},
		{"10-40/15 * * * *", "2026-03-01 10:26", "2026-03-01 10:40"},
		{"10-40/15 * * * *", "2026-03-01 10:40", "2026-03-01 11:10"},
		{"5,7,9 * * * *", "2026-03-01 10:07", "2026-03-01 10:09"},
		{"0 9-17/4 * * *", "2026-03-01 13:00", "2026-03-01 17:00"},
		{"0 9-17/4 * * *", "2026-03-01 17:00", "2026-03-02 09:00"},
		{"1,2-4,*/30 * * * *", "2026-03-01 10:04", "2026-03-01 10:30"},
		// Month and day names, any case.
		{"0 0 1 JAN,jul *", "2026-03-01 00:00", "2026-07-01 00:00"},
		{"0 12 * * MON-fri", "2026-03-06 12:00", "2026-03-09 12:00"}, // Fri → Mon
		{"0 0 * feb-mar sun", "2026-01-15 00:00", "2026-02-01 00:00"},
		// Day of week 7 is Sunday, like 0.
		{"0 0 * * 7", "2026-03-02 00:00", "2026-03-08 00:00"},
		{"0 0 * * 0", "2026-03-02 00:00", "2026-03-08 00:00"},
		{"0 0 * * 5-7", "2026-03-02 00:00", "2026-03-06 00:00"},
		// Both days restricted: either matches (the 13th, or a Friday).
		{"0 0 13 * fri", "2026-03-01 00:00", "2026-03-06 00:00"},
		{"0 0 13 * fri", "2026-03-06 00:00", "2026-03-13 00:00"},
		{"0 0 13 * fri", "2026-03-13 00:00", "2026-03-20 00:00"},
		{"0 0 1 * mon", "2026-03-24 00:00", "2026-03-30 00:00"},
		{"0 0 1 * mon", "2026-03-30 00:00", "2026-04-01 00:00"},
		// One starts with *: only the other counts.
		{"0 0 13 * *", "2026-03-01 00:00", "2026-03-13 00:00"},
		{"0 0 * * fri", "2026-03-07 00:00", "2026-03-13 00:00"},
		{"0 0 */10 * fri", "2026-03-01 00:00", "2026-05-01 00:00"}, // the 1st, 11th, 21st or 31st, and a Friday
		{"0 0 13 * */2", "2026-03-01 00:00", "2026-06-13 00:00"},   // a 13th on Sun, Tue, Thu or Sat
		// Days that only some months have.
		{"0 0 31 * *", "2026-04-01 00:00", "2026-05-31 00:00"},
		{"0 0 29 2 *", "2026-01-01 00:00", "2028-02-29 00:00"},
		{"30 23 L * *", "", ""}, // not a schedule: no run
		// Year rollover with a month list.
		{"59 23 31 12 *", "2026-12-31 23:59", "2027-12-31 23:59"},
	} {
		if tc.after == "" {
			if _, ok := NextRun(tc.schedule, time.Now()); ok {
				t.Errorf("%q: invalid schedule has a next run", tc.schedule)
			}
			continue
		}
		got, ok := NextRun(tc.schedule, at(tc.after))
		if !ok || !got.Equal(at(tc.want)) {
			t.Errorf("%q after %s = %s %v, want %s", tc.schedule, tc.after, got.Format("2006-01-02 15:04 Mon"), ok, tc.want)
		}
	}
}

func TestCronNextDropsSecondsAndZone(t *testing.T) {
	c, err := ParseCron("* * * * *")
	if err != nil {
		t.Fatal(err)
	}
	after := time.Date(2026, 3, 1, 10, 0, 30, 5, time.FixedZone("CET", 3600))
	got, ok := c.Next(after)
	if !ok || got.Location() != time.UTC || !got.Equal(time.Date(2026, 3, 1, 9, 1, 0, 0, time.UTC)) {
		t.Fatalf("next = %v", got)
	}
}

func TestCronNeverFires(t *testing.T) {
	for _, s := range []string{"0 0 30 2 *", "0 0 31 4,6,9,11 *"} {
		if next, ok := NextRun(s, at("2026-01-01 00:00")); ok {
			t.Errorf("%q fires at %v", s, next)
		}
	}
	// With a day of week too, the OR rule makes it fire on that weekday.
	if next, ok := NextRun("0 0 30 2 mon", at("2026-01-01 00:00")); !ok || !next.Equal(at("2026-02-02 00:00")) {
		t.Errorf("30 Feb or Monday = %v %v", next, ok)
	}
}

// Every schedule the manifest accepts parses, and every one it refuses
// doesn't: one validator.
func TestParseCronAgreesWithManifest(t *testing.T) {
	for _, s := range []string{"* * * * *", "0 3 * * *", "*/15 9-17 * JAN-dec mon-FRI", "0 0 1,15 * *", "5 4 * * sun", "0 0 * * 7"} {
		if _, err := ParseCron(s); err != nil {
			t.Errorf("%q: %v", s, err)
		}
	}
	for _, s := range []string{"@daily", "60 * * * *", "* * * *", "5/10 * * * *", "0 5-3 * * *", "0 0 0 * *", "0 0 * * 8"} {
		if _, err := ParseCron(s); err == nil {
			t.Errorf("%q accepted", s)
		}
	}
}
