package store

import (
	"context"
	"html"
	"strings"
)

// SearchResult is a page matching a search. Snippet is safe HTML: escaped
// text with matches wrapped in <mark>.
type SearchResult struct {
	TreeItem
	Snippet string  `json:"snippet"`
	Rank    float32 `json:"rank"`
}

// The indexed body is decoded page text and may contain markup, so headlines
// mark matches with control characters; the text is then escaped and only the
// sentinels become <mark> tags.
const (
	markStart    = "\x02"
	markStop     = "\x03"
	headlineOpts = `StartSel="` + markStart + `", StopSel="` + markStop + `", ` +
		`MaxFragments=2, MaxWords=18, MinWords=6, FragmentDelimiter=" … "`
)

var markReplacer = strings.NewReplacer(markStart, "<mark>", markStop, "</mark>")

func safeSnippet(s string) string { return markReplacer.Replace(html.EscapeString(s)) }

// reindex rebuilds a page's search_document from its name and, when html is
// non-nil, that HTML; otherwise the stored body is kept (a rename).
func reindex(ctx context.Context, tx querier, assetID string, html *string) error {
	var err error
	if html != nil {
		_, err = tx.Exec(ctx, `
			INSERT INTO search_document (asset_id, name, body)
			SELECT id, name, html_text($2) FROM asset WHERE id = $1::uuid
			ON CONFLICT (asset_id) DO UPDATE
			SET name = EXCLUDED.name, body = EXCLUDED.body, updated_at = now()`, assetID, *html)
	} else {
		_, err = tx.Exec(ctx, `
			UPDATE search_document d SET name = a.name, updated_at = now()
			FROM asset a WHERE a.id = d.asset_id AND d.asset_id = $1::uuid`, assetID)
	}
	return err
}

// Search finds the active pages sub can see that match q, best first. q uses
// web-search syntax: words, "quoted phrases", OR, and -excluded.
func (s *Store) Search(ctx context.Context, sub, q string, limit int) ([]SearchResult, error) {
	out := []SearchResult{}
	q = strings.TrimSpace(q)
	if q == "" {
		return out, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	rows, err := s.pool.Query(ctx, `
		SELECT a.id::text, a.name, a.slug, a.current_version, a.updated_at, r.level,
		       EXISTS (SELECT 1 FROM acl_entry e WHERE e.asset_id = a.id),
		       ts_headline('simple', d.body, query, $4),
		       ts_rank(d.tsv, query)
		FROM websearch_to_tsquery('simple', $2) query
		JOIN search_document d ON d.tsv @@ query
		JOIN asset a ON a.id = d.asset_id
		CROSS JOIN LATERAL (SELECT asset_access($1, a.id) AS level) r
		WHERE r.level > 0 AND a.deleted_at IS NULL AND a.archived_at IS NULL
		ORDER BY ts_rank(d.tsv, query) DESC, a.updated_at DESC
		LIMIT $3`, sub, q, limit, headlineOpts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		res := SearchResult{TreeItem: TreeItem{Kind: "page"}}
		var r Role
		if err := rows.Scan(&res.ID, &res.Name, &res.Slug, &res.Version, &res.UpdatedAt, &r,
			&res.Shared, &res.Snippet, &res.Rank); err != nil {
			return nil, err
		}
		res.Role = r.String()
		res.Snippet = safeSnippet(res.Snippet)
		out = append(out, res)
	}
	return out, rows.Err()
}
