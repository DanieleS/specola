package pageapp

import (
	"bytes"
	"image"
	"image/png"
	"testing"
)

func TestThemeColorOf(t *testing.T) {
	for in, want := range map[string]string{
		`<meta name="theme-color" content="#ABC">`:                                         "#aabbcc",
		`<META content='#0f766e' NAME=theme-color>`:                                        "#0f766e",
		`<meta name="theme-color" content="rebeccapurple">`:                                "",
		`<meta name="theme-color-x" content="#000000">`:                                    "",
		`<meta name="description" content="#123456"><p>`:                                   "",
		`<meta name="theme-color" content="#111"><meta name="theme-color" content="#222">`: "#111111",
	} {
		if got := ThemeColorOf(in); got != want {
			t.Errorf("ThemeColorOf(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestShortName(t *testing.T) {
	for in, want := range map[string]string{
		"Budget":                 "Budget",
		"Budget 2027 & more":     "Budget 2027",
		"Supercalifragilistic":   "Supercalifra",
		"Ünïcödé ñames longer x": "Ünïcödé",
	} {
		if got := ShortName(in); got != want {
			t.Errorf("ShortName(%q) = %q, want %q", in, got, want)
		}
	}
}


func TestLookOf(t *testing.T) {
	page := `<meta name="theme-color" content="#123456">`
	l := LookOf("id-1", "Budget plan for 2027", page, Settings{})
	if l.Name != "Budget plan for 2027" || l.ShortName != "Budget plan" || l.Display != "standalone" ||
		l.ThemeColor != "#123456" || l.BackgroundColor != "#123456" || !l.IconMaskable || l.IconSize != 0 ||
		l.IconURL(192) != GeneratedIcon("id-1", "Budget plan for 2027")[:len(GeneratedIcon("id-1", "x"))-len("{size}.png")]+"192.png" {
		t.Fatalf("defaults: %+v", l)
	}
	l = LookOf("id-1", "Budget", page, Settings{
		Name: "Zebra", ShortName: "Z", Display: "fullscreen", Orientation: "portrait",
		ThemeColor: "#000000", BackgroundColor: "#ffffff", Icon: "ab", IconSize: 1024,
	})
	if l.Name != "Zebra" || l.ShortName != "Z" || l.Display != "fullscreen" || l.Orientation != "portrait" ||
		l.ThemeColor != "#000000" || l.BackgroundColor != "#ffffff" || l.IconMaskable || l.IconURL(512) != "/app-icons/ab.png" {
		t.Fatalf("settings: %+v", l)
	}
	m := ManifestOf("/app/x/", "/app/x/", l)
	if len(m.Icons) != 1 || m.Icons[0].Sizes != "1024x1024" || m.Orientation != "portrait" {
		t.Fatalf("manifest: %+v", m)
	}
}

func TestValidate(t *testing.T) {
	for _, bad := range []Settings{
		{Name: string(make([]rune, 61))}, {ShortName: "Thirteen chrs"}, {Name: " padded"},
		{Display: "browser"}, {Orientation: "any"}, {ThemeColor: "#ABCDEF"}, {BackgroundColor: "red"},
	} {
		if bad.Validate() == nil {
			t.Errorf("%+v is valid", bad)
		}
	}
	if err := (Settings{Name: "Ok", ShortName: "Twelve chars", Display: "minimal-ui", ThemeColor: "#abcdef"}).Validate(); err != nil {
		t.Error(err)
	}
}

func TestCheckIcon(t *testing.T) {
	for _, c := range []struct {
		w, h int
		ok   bool
	}{{512, 512, true}, {1024, 1024, true}, {511, 511, false}, {512, 600, false}} {
		b := pngOf(t, c.w, c.h)
		size, err := CheckIcon(b)
		if (err == nil) != c.ok || (c.ok && size != c.w) {
			t.Errorf("%dx%d: %d %v", c.w, c.h, size, err)
		}
	}
	if _, err := CheckIcon([]byte("GIF89a")); err == nil {
		t.Error("not a PNG")
	}
}

func pngOf(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}
