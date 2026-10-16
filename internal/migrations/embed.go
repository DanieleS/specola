package migrations

import "embed"

// FS holds the goose SQL migrations, embedded so the binary carries its own
// schema and runs them on boot.
//
//go:embed *.sql
var FS embed.FS
