// External SVG sprites (<svg><use href="icons.svg#id"></use></svg>) can't
// work in a bundle: the page runs on an opaque origin, and browsers load a
// <use> reference only from the document's own origin, which no URL matches
// (Chromium: "Unsafe attempt to load URL … Domains, protocols and ports must
// match"). The icons come out blank, with no error the app can see. So the
// plugin looks for such references in the build and says how to fix them.

const ESC = (s) => s.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');

/**
 * Returns the SVG files that text (a JS chunk or HTML) refers to as sprites:
 * an "x.svg#id" string (a template's <use href="/icons.svg#id">, JSX
 * href="/icons.svg#id"), or a variable holding an SVG file's URL with a
 * fragment added (Vue's compiled templates, `${iconsUrl}#id`).
 * The names are as written, without the fragment.
 */
export function findSprites(text) {
  const found = new Set();
  for (const m of text.matchAll(/["'`]([^"'`\s<>()]*?\.svg)#[A-Za-z_][\w:.-]*/g)) found.add(m[1]);
  // name = …"x.svg"…, then name + "#id" or `${name}#id`.
  for (const m of text.matchAll(/(?:^|[\s,;{(])(?:(?:var|let|const)\s+)?([A-Za-z_$][\w$]*)\s*=[^,;=]{0,120}?["'`]([^"'`\s<>()]*?\.svg)["'`]/g)) {
    const name = ESC(m[1]);
    if (new RegExp(`(?<![\\w$.])${name}\\s*\\+\\s*["'\`]#|\\$\\{\\s*${name}\\s*\\}#`).test(text)) found.add(m[2]);
  }
  return [...found];
}

/** The advice for a bundle file that uses sprites. */
export function spriteWarning(file, sprites) {
  const list = sprites.map((s) => `"${s}"`).join(', ');
  return (
    `${file} uses ${list} as an external SVG sprite (<use href="…svg#id">): icons from it will be blank in a Specola bundle, ` +
    `which runs on an opaque origin, where browsers load <use> references only from the page itself (no URL works, ` +
    `not window.specola.base nor an imported ?url). Inline the sprite instead: import its markup with ` +
    `import sprite from './icons.svg?raw', put it in the page once (say, in a hidden <div> at the top of <body>), ` +
    `and refer to its symbols as <use href="#id">; or inline each icon's <svg>.`
  );
}
