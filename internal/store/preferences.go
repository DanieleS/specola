package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
)

// Agent preferences and folder conventions (docs/agent-preferences.md): what
// agents publishing through the MCP should use by default.
//
//   - A user's preferences are theirs alone: only they read or write them.
//   - A folder's conventions are written by its owner only, and read by anyone
//     who can see the folder. Sub-folders inherit them: the nearest folder up
//     the chain that has conventions is the one in force.
//   - A style reference is a page. It only counts, and is only described, for
//     a user who can see that page; setting one needs that too.

// MaxPreferenceRunes bounds the text of preferences and of conventions.
const MaxPreferenceRunes = 4000

// Publishing modes: the agent picks a single file or a bundle, or always
// publishes a bundle.
const (
	ModeAuto   = "auto"
	ModeBundle = "bundle"
)

// StyleRef is a page agents take colours, typography and components from.
type StyleRef struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Version  int     `json:"version"`
	FolderID *string `json:"folderId"`
}

// Preferences are a user's defaults for agents.
type Preferences struct {
	Mode string `json:"mode"`
	Text string `json:"text"`
	// StyleRefID is the stored reference; StyleRef describes it, and is nil
	// when there is none or the user can no longer see that page.
	StyleRefID *string    `json:"styleRefId"`
	StyleRef   *StyleRef  `json:"styleRef"`
	UpdatedAt  *time.Time `json:"updatedAt,omitempty"`
}

// empty reports whether the preferences ask nothing of an agent.
func (p *Preferences) empty() bool {
	return p.Mode == ModeAuto && p.Text == "" && p.StyleRef == nil
}

// PreferencesInput is what a user saves.
type PreferencesInput struct {
	Mode       string  `json:"mode"`
	Text       string  `json:"text"`
	StyleRefID *string `json:"styleRefId"`
}

// Conventions are the conventions set on one folder.
type Conventions struct {
	FolderID   string `json:"folderId"`
	FolderName string `json:"folderName"`
	// Path names the folder from the top of its tree, " / " between names;
	// a folder the reader can't see, this one included (its conventions are
	// inherited by a sub-folder shared with them), is "…", and so is
	// FolderName then.
	Path string `json:"path"`
	Text string `json:"text"`
	// StyleRefID is nil for a reader who neither sees the page nor owns
	// the folder.
	StyleRefID *string   `json:"styleRefId"`
	StyleRef   *StyleRef `json:"styleRef"`
	// UpdatedBy names who wrote them: their name and email, as known.
	UpdatedBy    string    `json:"updatedBy"`
	UpdatedBySub string    `json:"updatedBySub"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

// FolderConventions is what a folder's conventions dialog shows.
type FolderConventions struct {
	// Own are the conventions set on this folder; nil if none.
	Own *Conventions `json:"own"`
	// Effective are the conventions in force here: Own, or those inherited
	// from the nearest folder above that has some; nil if none.
	Effective *Conventions `json:"effective"`
	// CanEdit: the caller owns the folder.
	CanEdit bool `json:"canEdit"`
}

// cleanPrefText trims a preferences or conventions text and checks its
// length. NUL can't be stored in a text column, so it is dropped.
func cleanPrefText(s string) (string, error) {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\x00", ""))
	if !utf8.ValidString(s) {
		return "", &ErrInvalid{"text is not valid UTF-8"}
	}
	if utf8.RuneCountInString(s) > MaxPreferenceRunes {
		return "", &ErrInvalid{fmt.Sprintf("text is longer than %d characters", MaxPreferenceRunes)}
	}
	return s, nil
}

// styleRef describes page id for sub; nil when id is nil or sub can't see it.
func styleRef(ctx context.Context, q querier, sub string, id *string) (*StyleRef, error) {
	if id == nil {
		return nil, nil
	}
	var r StyleRef
	err := q.QueryRow(ctx, `
		SELECT a.id::text, a.name, a.current_version, a.folder_id::text
		FROM asset a
		WHERE a.id = $1::uuid AND asset_access($2, a.id) > 0`, *id, sub).
		Scan(&r.ID, &r.Name, &r.Version, &r.FolderID)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// checkStyleRef normalises a style reference being saved ("" is none) and
// checks that sub can see it. A reference left as it was stored (stored) is
// kept without the check, so that text can still be saved after the page
// became invisible; it doesn't count until it is visible again.
func checkStyleRef(ctx context.Context, q querier, sub string, id, stored *string) (*string, error) {
	if id == nil || strings.TrimSpace(*id) == "" {
		return nil, nil
	}
	v := strings.TrimSpace(*id)
	if stored != nil && *stored == v {
		return &v, nil
	}
	r, err := styleRef(ctx, q, sub, &v)
	if err != nil {
		return nil, err
	}
	if r == nil {
		return nil, &ErrInvalid{"style reference: no page with that id that you can see"}
	}
	return &r.ID, nil
}

// Preferences returns sub's preferences; the defaults when none are saved.
func (s *Store) Preferences(ctx context.Context, sub string) (*Preferences, error) {
	p := &Preferences{Mode: ModeAuto}
	var updated time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT mode, text, style_ref_asset_id::text, updated_at
		FROM user_preferences WHERE sub = $1`, sub).Scan(&p.Mode, &p.Text, &p.StyleRefID, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, nil
	}
	if err != nil {
		return nil, err
	}
	p.UpdatedAt = &updated
	if p.StyleRef, err = styleRef(ctx, s.pool, sub, p.StyleRefID); err != nil {
		return nil, err
	}
	return p, nil
}

// SetPreferences saves sub's preferences and returns them.
func (s *Store) SetPreferences(ctx context.Context, sub string, in PreferencesInput) (*Preferences, error) {
	mode := strings.TrimSpace(in.Mode)
	if mode == "" {
		mode = ModeAuto
	}
	if mode != ModeAuto && mode != ModeBundle {
		return nil, &ErrInvalid{`mode must be "auto" or "bundle"`}
	}
	text, err := cleanPrefText(in.Text)
	if err != nil {
		return nil, err
	}
	var stored *string
	err = s.pool.QueryRow(ctx, `SELECT style_ref_asset_id::text FROM user_preferences WHERE sub = $1`, sub).Scan(&stored)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	ref, err := checkStyleRef(ctx, s.pool, sub, in.StyleRefID, stored)
	if err != nil {
		return nil, err
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO user_preferences (sub, mode, text, style_ref_asset_id)
		VALUES ($1, $2, $3, $4::uuid)
		ON CONFLICT (sub) DO UPDATE SET
		  mode = EXCLUDED.mode, text = EXCLUDED.text,
		  style_ref_asset_id = EXCLUDED.style_ref_asset_id, updated_at = now()`,
		sub, mode, text, ref); err != nil {
		return nil, err
	}
	return s.Preferences(ctx, sub)
}

// conventionsAt returns the conventions in force in folderID as sub reads
// them: those set on the folder itself, or on the nearest folder above it
// that has some. nil if none. The callers check that sub can see the folder.
func conventionsAt(ctx context.Context, q querier, sub, folderID string) (*Conventions, error) {
	var c Conventions
	var name, email *string
	var srcOwner bool
	err := q.QueryRow(ctx, `
		WITH RECURSIVE chain AS (
		  SELECT id, parent_id, name, 0 AS depth FROM folder WHERE id = $1::uuid
		  UNION ALL
		  SELECT f.id, f.parent_id, f.name, c.depth + 1
		  FROM folder f JOIN chain c ON f.id = c.parent_id
		  WHERE c.depth < 64
		), src AS (
		  SELECT c.id, c.name, c.depth FROM chain c
		  JOIN folder_conventions fc ON fc.folder_id = c.id
		  ORDER BY c.depth LIMIT 1
		)
		SELECT src.id::text,
		       CASE WHEN folder_access($2, src.id, true) > 0 THEN src.name ELSE '…' END,
		       (SELECT string_agg(CASE WHEN folder_access($2, c.id, true) > 0
		                               THEN c.name ELSE '…' END, ' / ' ORDER BY c.depth DESC)
		        FROM chain c WHERE c.depth >= src.depth),
		       folder_access($2, src.id, true) >= 3,
		       fc.text, fc.style_ref_asset_id::text, fc.updated_by_sub, u.name, u.email, fc.updated_at
		FROM src
		JOIN folder_conventions fc ON fc.folder_id = src.id
		LEFT JOIN app_user u ON u.sub = fc.updated_by_sub`, folderID, sub).
		Scan(&c.FolderID, &c.FolderName, &c.Path, &srcOwner, &c.Text, &c.StyleRefID, &c.UpdatedBySub, &name, &email, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) || isInvalidText(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.UpdatedBy = displayUser(c.UpdatedBySub, name, email)
	if c.StyleRef, err = styleRef(ctx, q, sub, c.StyleRefID); err != nil {
		return nil, err
	}
	// The id of a reference the reader can't see is kept only for the
	// folder's owners, who may save the conventions with it unchanged.
	if c.StyleRef == nil && !srcOwner {
		c.StyleRefID = nil
	}
	return &c, nil
}

// displayUser names a user by name and email, as far as they are known.
func displayUser(sub string, name, email *string) string {
	n, e := "", ""
	if name != nil {
		n = strings.TrimSpace(*name)
	}
	if email != nil {
		e = strings.TrimSpace(*email)
	}
	switch {
	case n != "" && e != "" && n != e:
		return n + " <" + e + ">"
	case e != "":
		return e
	case n != "":
		return n
	}
	return sub
}

// FolderConventions returns the conventions of a folder sub can see.
func (s *Store) FolderConventions(ctx context.Context, sub, folderID string) (*FolderConventions, error) {
	r, err := folderRole(ctx, s.pool, folderID, sub)
	if err != nil {
		return nil, err
	}
	if err := need(r, RoleViewer); err != nil {
		return nil, err
	}
	out := &FolderConventions{CanEdit: r >= RoleOwner}
	if out.Effective, err = conventionsAt(ctx, s.pool, sub, folderID); err != nil {
		return nil, err
	}
	if out.Effective != nil && out.Effective.FolderID == folderID {
		out.Own = out.Effective
	}
	return out, nil
}

// SetFolderConventions sets the conventions of a folder sub owns. Empty text
// with no style reference removes them.
func (s *Store) SetFolderConventions(ctx context.Context, sub, folderID, text string, styleRefID *string) (*FolderConventions, error) {
	if err := s.needOwner(ctx, sub, KindFolder, folderID); err != nil {
		return nil, err
	}
	text, err := cleanPrefText(text)
	if err != nil {
		return nil, err
	}
	var stored *string
	err = s.pool.QueryRow(ctx, `SELECT style_ref_asset_id::text FROM folder_conventions WHERE folder_id = $1::uuid`, folderID).Scan(&stored)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	ref, err := checkStyleRef(ctx, s.pool, sub, styleRefID, stored)
	if err != nil {
		return nil, err
	}
	if text == "" && ref == nil {
		return s.DeleteFolderConventions(ctx, sub, folderID)
	}
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO folder_conventions (folder_id, text, style_ref_asset_id, updated_by_sub)
		VALUES ($1::uuid, $2, $3::uuid, $4)
		ON CONFLICT (folder_id) DO UPDATE SET
		  text = EXCLUDED.text, style_ref_asset_id = EXCLUDED.style_ref_asset_id,
		  updated_by_sub = EXCLUDED.updated_by_sub, updated_at = now()`,
		folderID, text, ref, sub); err != nil {
		return nil, err
	}
	return s.FolderConventions(ctx, sub, folderID)
}

// DeleteFolderConventions removes the conventions of a folder sub owns;
// those of a folder above, if any, then apply.
func (s *Store) DeleteFolderConventions(ctx context.Context, sub, folderID string) (*FolderConventions, error) {
	if err := s.needOwner(ctx, sub, KindFolder, folderID); err != nil {
		return nil, err
	}
	if _, err := s.pool.Exec(ctx, `DELETE FROM folder_conventions WHERE folder_id = $1::uuid`, folderID); err != nil {
		return nil, err
	}
	return s.FolderConventions(ctx, sub, folderID)
}

// AgentConventions is what an agent publishing for sub into a folder should
// respect, besides the user's explicit request.
type AgentConventions struct {
	// At is the folder published into; nil for the root.
	At *string
	// Folder are the conventions in force in the folder; nil if none.
	Folder *Conventions
	// User are sub's preferences; nil if they ask nothing.
	User *Preferences
	// StyleRef is the style reference that counts: the folder's if sub can
	// see it, else the user's; StyleRefFrom says which ("folder", "user").
	StyleRef     *StyleRef
	StyleRefFrom string
}

// Empty reports whether nothing applies.
func (a *AgentConventions) Empty() bool {
	return a == nil || (a.Folder == nil && a.User == nil)
}

// AgentConventions returns what applies when sub publishes into folderID
// (nil: their root, where only their preferences apply). sub must be able to
// see the folder.
func (s *Store) AgentConventions(ctx context.Context, sub string, folderID *string) (*AgentConventions, error) {
	if err := checkFolder(ctx, s.pool, folderID, sub, RoleViewer); err != nil {
		return nil, err
	}
	return s.agentConventions(ctx, sub, folderID)
}

// AgentConventionsForPage returns what applies when sub publishes a version
// of page id: the conventions of the folder it is in, even when the page is
// shared with sub on its own and the folder isn't, besides sub's preferences.
func (s *Store) AgentConventionsForPage(ctx context.Context, sub, id string) (*AgentConventions, error) {
	if err := checkPage(ctx, s.pool, id, sub, RoleViewer); err != nil {
		return nil, err
	}
	var folderID *string
	if err := s.pool.QueryRow(ctx, `SELECT folder_id::text FROM asset WHERE id = $1::uuid`, id).Scan(&folderID); err != nil {
		return nil, err
	}
	return s.agentConventions(ctx, sub, folderID)
}

func (s *Store) agentConventions(ctx context.Context, sub string, folderID *string) (*AgentConventions, error) {
	out := &AgentConventions{At: folderID}
	if folderID != nil {
		c, err := conventionsAt(ctx, s.pool, sub, *folderID)
		if err != nil {
			return nil, err
		}
		out.Folder = c
	}
	p, err := s.Preferences(ctx, sub)
	if err != nil {
		return nil, err
	}
	if !p.empty() {
		out.User = p
	}
	switch {
	case out.Folder != nil && out.Folder.StyleRef != nil:
		out.StyleRef, out.StyleRefFrom = out.Folder.StyleRef, "folder"
	case out.User != nil && out.User.StyleRef != nil:
		out.StyleRef, out.StyleRefFrom = out.User.StyleRef, "user"
	}
	return out, nil
}

// markConventions flags the folders among items that have conventions set
// on them.
func markConventions(ctx context.Context, q querier, items []TreeItem) error {
	var ids []string
	for _, it := range items {
		if it.Kind == "folder" {
			ids = append(ids, it.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := q.Query(ctx, `SELECT folder_id::text FROM folder_conventions WHERE folder_id = ANY($1::uuid[])`, ids)
	if err != nil {
		return err
	}
	has := map[string]bool{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		has[id] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for i := range items {
		if items[i].Kind == "folder" && has[items[i].ID] {
			items[i].Conventions = true
		}
	}
	return nil
}
