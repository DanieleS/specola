package server

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"regexp"
	"strings"
)

// pageSDK defines window.specola in every page served, ahead of the page's
// own scripts; see pagesdk.js. It is added when a page is served, not stored,
// so search, MCP reads and the history keep the HTML as published.
//
//go:embed pagesdk.js
var pageSDK string

var (
	sdkTag = "<script>" + stripComments(pageSDK) + "</script>"
	// sdkTag goes after a leading doctype (and any comments before it), which
	// must come before any element or the page falls back to quirks mode.
	leadingDoctype = regexp.MustCompile(`(?is)^\x{FEFF}?(?:\s|<!--.*?-->)*<!doctype[^>]*>`)
	// sdkVersion is part of a page's ETag, so a new SDK reaches cached pages.
	sdkVersion = func() string { h := sha256.Sum256([]byte(pageSDK)); return hex.EncodeToString(h[:4]) }()
)

// stripComments drops the whole-line comments that document pagesdk.js, which
// every page would otherwise carry.
func stripComments(js string) string {
	var b strings.Builder
	for _, line := range strings.Split(js, "\n") {
		if t := strings.TrimSpace(line); t != "" && !strings.HasPrefix(t, "//") {
			b.WriteString(line)
			b.WriteByte('\n')
		}
	}
	return b.String()
}

// withSDK returns html with the SDK script added.
func withSDK(html string) string {
	n := 0
	if loc := leadingDoctype.FindStringIndex(html); loc != nil {
		n = loc[1]
	}
	return html[:n] + sdkTag + html[n:]
}
