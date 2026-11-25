// Package pageapp is how a page looks installed as an app (docs/page-apps.md):
// its settings and their defaults, its web app manifest, and its icons, the
// generated ones drawn here. The server serves it; the MCP tools change it.
package pageapp

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// DefaultThemeColor is Specola's own, for a page that sets none.
const DefaultThemeColor = "#0b0d12"

// Limits on what an author sets.
const (
	MaxName      = 60
	MaxShortName = 12
	// MaxIconBytes and MinIconSize bound an uploaded icon: a square PNG.
	MaxIconBytes = 1 << 20
	MinIconSize  = 512
)

// Displays and Orientations are the values an author may choose.
var (
	Displays     = []string{"standalone", "fullscreen", "minimal-ui"}
	Orientations = []string{"portrait", "landscape"}
)

var hexColor = regexp.MustCompile(`^#[0-9a-f]{6}$`)

// Settings are what a page's author set ("" or 0: the default).
type Settings struct {
	Name            string
	ShortName       string
	Display         string
	Orientation     string
	ThemeColor      string
	BackgroundColor string
	// Icon is an uploaded icon's sha256 (hex), IconSize its width (and
	// height); "" for the generated icon.
	Icon         string
	IconSize     int
	IconMaskable bool
}

// Validate says what is wrong with s, if anything, in words an author (or
// an agent) can act on.
func (s Settings) Validate() error {
	switch {
	case utf8.RuneCountInString(s.Name) > MaxName:
		return fmt.Errorf("the name can be at most %d characters", MaxName)
	case utf8.RuneCountInString(s.ShortName) > MaxShortName:
		return fmt.Errorf("the short name can be at most %d characters", MaxShortName)
	case strings.TrimSpace(s.Name) != s.Name, strings.TrimSpace(s.ShortName) != s.ShortName:
		return errors.New("names can't start or end with spaces")
	case s.Display != "" && !slices.Contains(Displays, s.Display):
		return fmt.Errorf("display must be one of %s", strings.Join(Displays, ", "))
	case s.Orientation != "" && !slices.Contains(Orientations, s.Orientation):
		return fmt.Errorf("orientation must be one of %s", strings.Join(Orientations, ", "))
	case s.ThemeColor != "" && !hexColor.MatchString(s.ThemeColor):
		return errors.New("the theme color must be #rrggbb, in lower case")
	case s.BackgroundColor != "" && !hexColor.MatchString(s.BackgroundColor):
		return errors.New("the background color must be #rrggbb, in lower case")
	}
	return nil
}

// Look is how an app looks, defaults filled in.
type Look struct {
	Name            string
	ShortName       string
	Display         string
	Orientation     string
	ThemeColor      string
	BackgroundColor string
	// Icon is the icon's URL, with "{size}" for a generated icon's size
	// (192 or 512); IconSize is an uploaded icon's size, 0 for a generated
	// one.
	Icon         string
	IconSize     int
	IconMaskable bool
}

// LookOf is how the app of page id looks: its author's settings, the rest
// from the page's name and the HTML of the version shown.
func LookOf(id, name, page string, s Settings) Look {
	l := Look{
		Name:            strings.TrimSpace(name),
		Display:         "standalone",
		ThemeColor:      ThemeColorOf(page),
		Icon:            GeneratedIcon(id, name),
		IconMaskable:    true,
		Orientation:     s.Orientation,
		BackgroundColor: s.BackgroundColor,
	}
	if l.Name == "" {
		l.Name = "Page"
	}
	if s.Name != "" {
		l.Name = s.Name
		l.Icon = GeneratedIcon(id, s.Name)
	}
	l.ShortName = ShortName(l.Name)
	if s.ShortName != "" {
		l.ShortName = s.ShortName
	}
	if s.Display != "" {
		l.Display = s.Display
	}
	if s.ThemeColor != "" {
		l.ThemeColor = s.ThemeColor
	}
	if l.ThemeColor == "" {
		l.ThemeColor = DefaultThemeColor
	}
	if l.BackgroundColor == "" {
		l.BackgroundColor = l.ThemeColor
	}
	if s.Icon != "" {
		l.Icon, l.IconSize, l.IconMaskable = UploadedIcon(s.Icon), s.IconSize, s.IconMaskable
	}
	return l
}

// IconURL is the icon at size (a generated icon is drawn at 192 or 512; an
// uploaded one is the same image at any size).
func (l Look) IconURL(size int) string {
	return strings.Replace(l.Icon, "{size}", strconv.Itoa(size), 1)
}

// UploadedIcon is where an uploaded icon is served, by its sha256.
func UploadedIcon(sha string) string { return "/app-icons/" + sha + ".png" }

// Manifest is a web app manifest, as page apps write it.
type Manifest struct {
	ID              string `json:"id"`
	StartURL        string `json:"start_url"`
	Scope           string `json:"scope"`
	Name            string `json:"name"`
	ShortName       string `json:"short_name"`
	Display         string `json:"display"`
	Orientation     string `json:"orientation,omitempty"`
	ThemeColor      string `json:"theme_color"`
	BackgroundColor string `json:"background_color"`
	Icons           []Icon `json:"icons"`
}

// Icon is a manifest's icon.
type Icon struct {
	Src     string `json:"src"`
	Sizes   string `json:"sizes"`
	Type    string `json:"type"`
	Purpose string `json:"purpose"`
}

// ManifestOf is the manifest of an app whose id and start are base and
// whose scope is scope.
func ManifestOf(base, scope string, l Look) Manifest {
	m := Manifest{
		ID: base, StartURL: base, Scope: scope,
		Name: l.Name, ShortName: l.ShortName, Display: l.Display, Orientation: l.Orientation,
		ThemeColor: l.ThemeColor, BackgroundColor: l.BackgroundColor,
	}
	sizes := []int{192, 512}
	if l.IconSize > 0 {
		sizes = []int{l.IconSize}
	}
	px := func(n int) string { return strconv.Itoa(n) + "x" + strconv.Itoa(n) }
	for _, n := range sizes {
		m.Icons = append(m.Icons, Icon{Src: l.IconURL(n), Sizes: px(n), Type: "image/png", Purpose: "any"})
	}
	if l.IconMaskable {
		n := sizes[len(sizes)-1]
		m.Icons = append(m.Icons, Icon{Src: l.IconURL(n), Sizes: px(n), Type: "image/png", Purpose: "maskable"})
	}
	return m
}

var (
	themeMeta  = regexp.MustCompile(`(?is)<meta\s[^>]*name\s*=\s*["']?theme-color(?:["'\s/][^>]*)?>`)
	contentAtt = regexp.MustCompile(`(?is)\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	anyHex     = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$`)
)

// ThemeColorOf is the first <meta name="theme-color"> of a page, as
// #rrggbb, or "" when it has none in that form.
func ThemeColorOf(page string) string {
	tag := themeMeta.FindString(page)
	if tag == "" {
		return ""
	}
	m := contentAtt.FindStringSubmatch(tag)
	if m == nil {
		return ""
	}
	c := strings.TrimSpace(m[1] + m[2] + m[3])
	if !anyHex.MatchString(c) {
		return ""
	}
	c = strings.ToLower(c)
	if len(c) == 4 {
		c = "#" + strings.Repeat(c[1:2], 2) + strings.Repeat(c[2:3], 2) + strings.Repeat(c[3:4], 2)
	}
	return c
}

// ShortName is name cut to MaxShortName characters, at a word boundary
// when there is one: what fits under an icon.
func ShortName(name string) string {
	if utf8.RuneCountInString(name) <= MaxShortName {
		return name
	}
	r := []rune(name)[:MaxShortName]
	if i := strings.LastIndexFunc(string(r), unicode.IsSpace); i > 0 {
		return strings.TrimSpace(string(r)[:i])
	}
	return string(r)
}

// GeneratedIcon is the URL ("{size}" in it) of a page's generated icon:
// the first letter or digit of its name on a color picked from its id, so
// two apps on one device are told apart.
func GeneratedIcon(id, name string) string {
	sum := sha256.Sum256([]byte(id))
	color := Palette[int(sum[0])%len(Palette)]
	return "/app-icons/g/" + color + "/" + url.PathEscape(string(IconLetter(name))) + "/{size}.png"
}
