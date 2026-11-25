package server

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"sync"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
)

// Generated app icons (docs/page-apps.md, "Icons"): a letter in white on one
// of a few colors, full bleed, so the same image serves as a plain and a
// maskable icon (the letter stays inside the central safe zone).

// iconPalette are the background colors, dark enough for white text.
var iconPalette = []string{
	"b91c1c", "c2410c", "b45309", "4d7c0f", "15803d", "0f766e",
	"0e7490", "1d4ed8", "4338ca", "6d28d9", "a21caf", "be185d",
}

// iconSizes are the sizes generated icons come in.
var iconSizes = map[string]int{"192.png": 192, "512.png": 512}

// iconFallback is the letter for a name with none the font can draw.
const iconFallback = 'P'

var iconFont = sync.OnceValue(func() *opentype.Font {
	f, err := opentype.Parse(gobold.TTF)
	if err != nil {
		panic(err)
	}
	return f
})

// drawable reports whether the icon font has a glyph for r.
func drawable(r rune) bool {
	var buf sfnt.Buffer
	i, err := iconFont().GlyphIndex(&buf, r)
	return err == nil && i != 0
}

// iconLetter is the letter a name's icon shows: its first letter or digit,
// upper case, if the font has it.
func iconLetter(name string) rune {
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if u := unicode.ToUpper(r); drawable(u) {
				return u
			}
			break
		}
	}
	return iconFallback
}

// iconCache holds the icons drawn, by URL path: at most 12 colors × 2 sizes
// per letter in use.
var iconCache sync.Map

func handleGeneratedIcon(w http.ResponseWriter, r *http.Request) {
	color := chi.URLParam(r, "color")
	size, okSize := iconSizes[chi.URLParam(r, "size")]
	letter, err := url.PathUnescape(chi.URLParam(r, "letter"))
	l, n := utf8.DecodeRuneInString(letter)
	if !okSize || err != nil || !slices.Contains(iconPalette, color) || n != len(letter) ||
		!(unicode.IsLetter(l) || unicode.IsDigit(l)) || unicode.ToUpper(l) != l || !drawable(l) {
		http.NotFound(w, r)
		return
	}
	key := color + "/" + string(l) + "/" + strconv.Itoa(size)
	img, ok := iconCache.Load(key)
	if !ok {
		b, err := drawIcon(color, l, size)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		img, _ = iconCache.LoadOrStore(key, b)
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(img.([]byte))
}

// drawIcon draws a size×size PNG of letter in white, centered, on color
// (rrggbb).
func drawIcon(rrggbb string, letter rune, size int) ([]byte, error) {
	bg, err := parseHex(rrggbb)
	if err != nil {
		return nil, err
	}
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	draw.Draw(img, img.Bounds(), image.NewUniform(bg), image.Point{}, draw.Src)

	face, err := opentype.NewFace(iconFont(), &opentype.FaceOptions{
		Size: float64(size) * 0.5, DPI: 72, Hinting: font.HintingNone,
	})
	if err != nil {
		return nil, err
	}
	defer face.Close()
	s := string(letter)
	b, _ := font.BoundString(face, s)
	half := fixed.I(size) / 2
	d := &font.Drawer{Dst: img, Src: image.White, Face: face, Dot: fixed.Point26_6{
		X: half - (b.Max.X-b.Min.X)/2 - b.Min.X,
		Y: half - (b.Max.Y-b.Min.Y)/2 - b.Min.Y,
	}}
	d.DrawString(s)

	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func parseHex(s string) (color.RGBA, error) {
	c, err := hex.DecodeString(s)
	if err != nil || len(c) != 3 {
		return color.RGBA{}, fmt.Errorf("bad color %q", s)
	}
	return color.RGBA{c[0], c[1], c[2], 255}, nil
}
