package mcpserver

import (
	"context"
	"encoding/base64"
	"errors"

	"github.com/danieles/specola/internal/pageapp"
	"github.com/danieles/specola/internal/store"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Page apps (docs/page-apps.md): any page can be installed as an app, from
// app_url when signed in and from any of its public links without an
// account. Its editors set how it looks.

const setPageAppDesc = `Set how a page looks when installed as an app (a PWA on a phone's home screen or a computer's dock), for a page the user can edit. Anyone who can see the page installs it from its app_url; anyone with a public link installs it from the link itself. Every field is optional: one left out stays as it is, and "" resets it to its default. Defaults: the page's title as name, a short name cut from it, display "standalone", the theme color from the page's <meta name="theme-color">, and a generated icon (the name's first letter on a color). icon_png_base64 sets the icon: a square PNG, at least 512×512, at most 1 MB; set icon_maskable when its content stays inside the central 80% (Android crops it to a shape). generated_icon: true goes back to the generated icon. Returns the look in effect and the app_url.`

type setPageAppIn struct {
	ID              string  `json:"id" jsonschema:"id of the page"`
	Name            *string `json:"name,omitempty" jsonschema:"the app's name, up to 60 characters; \"\" for the page's title"`
	ShortName       *string `json:"short_name,omitempty" jsonschema:"shown under the icon, up to 12 characters; \"\" for one cut from the name"`
	Display         *string `json:"display,omitempty" jsonschema:"standalone, fullscreen or minimal-ui; \"\" for standalone"`
	Orientation     *string `json:"orientation,omitempty" jsonschema:"portrait or landscape; \"\" for any"`
	ThemeColor      *string `json:"theme_color,omitempty" jsonschema:"#rrggbb in lower case; \"\" for the page's own theme-color"`
	BackgroundColor *string `json:"background_color,omitempty" jsonschema:"#rrggbb in lower case, shown while the app starts; \"\" for the theme color"`
	IconMaskable    *bool   `json:"icon_maskable,omitempty" jsonschema:"the uploaded icon's content stays inside the central 80%"`
	IconPNGBase64   string  `json:"icon_png_base64,omitempty" jsonschema:"a square PNG icon, at least 512×512, at most 1 MB, base64-encoded"`
	GeneratedIcon   bool    `json:"generated_icon,omitempty" jsonschema:"go back to the generated icon"`
}

type pageAppOut struct {
	Name            string `json:"name"`
	ShortName       string `json:"short_name"`
	Display         string `json:"display"`
	Orientation     string `json:"orientation,omitempty"`
	ThemeColor      string `json:"theme_color"`
	BackgroundColor string `json:"background_color"`
	Icon            string `json:"icon" jsonschema:"the icon's URL"`
	IconMaskable    bool   `json:"icon_maskable"`
	AppURL          string `json:"app_url" jsonschema:"where anyone who can see the page installs it"`
}

func (t *tools) appURL(id string) string { return t.opts.BaseURL + "/app/" + id + "/" }

func (t *tools) setPageApp(ctx context.Context, req *mcp.CallToolRequest, in setPageAppIn) (*mcp.CallToolResult, pageAppOut, error) {
	who, err := t.caller(ctx, req)
	if err != nil {
		return nil, pageAppOut{}, err
	}
	if in.IconPNGBase64 != "" && in.GeneratedIcon {
		return nil, pageAppOut{}, errors.New("give icon_png_base64 or generated_icon, not both")
	}
	_, err = t.st.SetAppSettings(ctx, who.Sub, in.ID, store.AppSettingsChange{
		Name: in.Name, ShortName: in.ShortName, Display: in.Display, Orientation: in.Orientation,
		ThemeColor: in.ThemeColor, BackgroundColor: in.BackgroundColor, IconMaskable: in.IconMaskable,
	})
	if err != nil {
		return nil, pageAppOut{}, toolError(err, "page")
	}
	switch {
	case in.IconPNGBase64 != "":
		png, err := base64.StdEncoding.DecodeString(in.IconPNGBase64)
		if err != nil {
			return nil, pageAppOut{}, errors.New("icon_png_base64 is not valid base64")
		}
		if _, err := t.st.SetAppIcon(ctx, who.Sub, in.ID, png, in.IconMaskable); err != nil {
			return nil, pageAppOut{}, toolError(err, "page")
		}
	case in.GeneratedIcon:
		if _, err := t.st.DeleteAppIcon(ctx, who.Sub, in.ID); err != nil {
			return nil, pageAppOut{}, toolError(err, "page")
		}
	}
	out, err := t.pageApp(ctx, who.Sub, in.ID)
	if err != nil {
		return nil, pageAppOut{}, toolError(err, "page")
	}
	return nil, out, nil
}

// pageApp is how page id's app looks, for sub.
func (t *tools) pageApp(ctx context.Context, sub, id string) (pageAppOut, error) {
	meta, err := t.st.PageMeta(ctx, sub, id)
	if err != nil {
		return pageAppOut{}, err
	}
	content, err := t.st.CurrentContent(ctx, sub, id)
	if err != nil {
		return pageAppOut{}, err
	}
	settings, err := t.st.AppSettings(ctx, meta.ID)
	if err != nil {
		return pageAppOut{}, err
	}
	l := pageapp.LookOf(meta.ID, meta.Name, content, settings)
	return pageAppOut{
		Name: l.Name, ShortName: l.ShortName, Display: l.Display, Orientation: l.Orientation,
		ThemeColor: l.ThemeColor, BackgroundColor: l.BackgroundColor,
		Icon: t.opts.BaseURL + l.IconURL(512), IconMaskable: l.IconMaskable,
		AppURL: t.appURL(meta.ID),
	}, nil
}
