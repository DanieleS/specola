import type { Plugin } from 'vite';

/** Bundle limits. The server's values are the defaults; lower them to fail
 * earlier (raising them only moves the failure to the upload). */
export interface SpecolaLimits {
  /** Files per bundle, index.html included. Default 2000. */
  maxFiles?: number;
  /** Bytes per file other than index.html. Default 25 MiB. */
  maxFileBytes?: number;
  /** Bytes of index.html. Default 5 MiB. */
  maxIndexBytes?: number;
  /** Bytes of the whole bundle. Default 100 MiB. */
  maxBundleBytes?: number;
}

export interface SpecolaOptions {
  /**
   * Text that Specola's full-text search should find the page by. A bundle's
   * content is rendered by JavaScript, so without it only the title and the
   * static markup of index.html are indexed. Emitted as
   * `<noscript data-specola-search>…</noscript>` in index.html.
   */
  searchText?: string;
  /** Overrides of the bundle limits checked at build time. */
  limits?: SpecolaLimits;
}

/** The Specola Vite plugin: builds the app as a Specola bundle. */
export declare function specola(options?: SpecolaOptions): Plugin;
export default specola;

/** This plugin's version. */
export declare const VERSION: string;

/** What Specola's page SDK provides at runtime (and the plugin, under `vite dev`). */
export interface SpecolaRuntime {
  /** The URL the bundle's files are served under, ending in "/" ("/" in dev, "" for plain pages). */
  base: string;
  /** The path prefix the page is served under, for client-side routers ("" in dev). */
  basename: string;
  /** Whether localStorage writes are saved by Specola. */
  persistent: boolean;
  /** Saves pending localStorage writes now. */
  flush(): Promise<void>;
}

declare global {
  interface Window {
    specola?: SpecolaRuntime;
  }
}
