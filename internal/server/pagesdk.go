package server

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
)

// pageSDK defines window.specola in every page served, ahead of the page's
// own scripts; see pagesdk.js. It is added when a page is served, not stored,
// so search, MCP reads and the history keep the HTML as published.
//
//go:embed pagesdk.js
var pageSDK string

// bootPlaceholder is where pagesdk.js takes its boot data, which is per
// request: the SDK is a function called with it.
const bootPlaceholder = "SPECOLA_BOOT"

var (
	sdkHead, sdkTail = func() (string, string) {
		head, tail, ok := strings.Cut("<script>"+stripComments(pageSDK)+"</script>", bootPlaceholder)
		if !ok || strings.Contains(tail, bootPlaceholder) {
			panic("pagesdk.js must name " + bootPlaceholder + " exactly once")
		}
		return head, tail
	}()
	// The SDK goes after a leading doctype (and any comments before it), which
	// must come before any element or the page falls back to quirks mode.
	leadingDoctype = regexp.MustCompile(`(?is)^\x{FEFF}?(?:\s|<!--.*?-->)*<!doctype[^>]*>`)
	// sdkVersion is part of a page's ETag, so a new SDK reaches cached pages.
	sdkVersion = func() string { h := sha256.Sum256([]byte(pageSDK)); return hex.EncodeToString(h[:4]) }()
)

// bootData tells the SDK where the page is served (docs/spa-bundles.md, "Page
// SDK additions"): Base is the bundle's file URL ending in "/" ("" for a plain
// page) and Basename the path prefix the page is served under, for an app's
// client-side router.
type bootData struct {
	Base     string `json:"base"`
	Basename string `json:"basename"`
}

// sdkTag is the SDK's script element with boot passed in. json.Marshal
// escapes <, > and &, so nothing in boot can close the script.
func sdkTag(boot bootData) string {
	b, _ := json.Marshal(boot)
	return sdkHead + string(b) + sdkTail
}

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
func withSDK(html string, boot bootData) string {
	n := 0
	if loc := leadingDoctype.FindStringIndex(html); loc != nil {
		n = loc[1]
	}
	return html[:n] + sdkTag(boot) + html[n:]
}
