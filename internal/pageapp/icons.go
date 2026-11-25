package pageapp

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"sync"
	"unicode"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
)

// Generated icons (docs/page-apps.md, "Icons"): a letter in white on one of
// a few colors, full bleed, so the same image serves as a plain and a
// maskable icon (the letter stays inside the central safe zone).

// Palette are the background colors, dark enough for white text.
var Palette = []string{
	"b91c1c", "c2410c", "b45309", "4d7c0f", "15803d", "0f766e",
	"0e7490", "1d4ed8", "4338ca", "6d28d9", "a21caf", "be185d",
}

// iconFallback is the letter for a name with none the font can draw.
const iconFallback = 'P'

var iconFont = sync.OnceValue(func() *opentype.Font {
	f, err := opentype.Parse(gobold.TTF)
	if err != nil {
		panic(err)
	}
	return f
})

// Drawable reports whether the icon font has a glyph for r.
func Drawable(r rune) bool {
	var buf sfnt.Buffer
	i, err := iconFont().GlyphIndex(&buf, r)
	return err == nil && i != 0
}

// IconLetter is the letter a name's icon shows: its first letter or digit,
// upper case, if the font has it.
func IconLetter(name string) rune {
	for _, r := range name {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			if u := unicode.ToUpper(r); Drawable(u) {
				return u
			}
			break
		}
	}
	return iconFallback
}

// DrawIcon draws a size×size PNG of letter in white, centered, on rrggbb.
func DrawIcon(rrggbb string, letter rune, size int) ([]byte, error) {
	c, err := hex.DecodeString(rrggbb)
	if err != nil || len(c) != 3 {
		return nil, fmt.Errorf("bad color %q", rrggbb)
	}
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	draw.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{c[0], c[1], c[2], 255}), image.Point{}, draw.Src)

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

// CheckIcon checks an uploaded icon: a PNG that decodes, square, at least
// MinIconSize wide, at most MaxIconBytes. It returns its size.
func CheckIcon(b []byte) (int, error) {
	if len(b) > MaxIconBytes {
		return 0, fmt.Errorf("the icon can be at most %d KB", MaxIconBytes>>10)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return 0, fmt.Errorf("the icon must be a PNG image (%v)", err)
	}
	r := img.Bounds()
	switch {
	case r.Dx() != r.Dy():
		return 0, fmt.Errorf("the icon must be square; it is %d × %d", r.Dx(), r.Dy())
	case r.Dx() < MinIconSize:
		return 0, fmt.Errorf("the icon must be at least %d × %d; it is %d × %d", MinIconSize, MinIconSize, r.Dx(), r.Dy())
	}
	return r.Dx(), nil
}
