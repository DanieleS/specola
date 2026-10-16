package store

import (
	"fmt"
	"strings"
)

// slugify turns a display name into a URL-safe slug: lowercase ASCII letters
// and digits, runs of other characters collapsed to a single dash.
func slugify(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	prevDash := false
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevDash = false
		default:
			if !prevDash {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "page"
	}
	if len(out) > 60 {
		out = strings.Trim(out[:60], "-")
	}
	return out
}

// withSuffix returns base for i==0, then base-2, base-3, … for collision retries.
func withSuffix(base string, i int) string {
	if i == 0 {
		return base
	}
	return fmt.Sprintf("%s-%d", base, i+1)
}
