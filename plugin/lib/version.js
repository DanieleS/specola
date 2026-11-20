import { readFileSync } from 'node:fs';

/** The plugin's version, read from its own package.json so there is a single
 * source of truth (it goes into the generator meta and the upload manifest). */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
