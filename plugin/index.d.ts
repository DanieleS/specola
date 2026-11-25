/// <reference path="./client.d.ts" />
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

/**
 * The page backend's manifest (docs/page-backends.md), written to
 * .specola/backend.json; or keep it in specola.backend.json next to
 * vite.config. The plugin sets "version" and "entry".
 */
export interface SpecolaBackendOptions {
  /** Routes an anonymous public-link visitor may call: "METHOD /path", "*" as the last segment matching the rest. */
  public?: string[];
  /** Hosts the backend may reach over HTTP(S); a leading "*." matches subdomains. */
  egress?: string[];
  /** Names of the secrets the code expects ([A-Z][A-Z0-9_]*); values are set by the page's owner. */
  secrets?: string[];
  /** Scheduled jobs: 5-field cron in UTC, at most 10. */
  cron?: { name: string; schedule: string }[];
  /** Push topics a public-link visitor may subscribe to. */
  topics?: { public?: string[] };
  /** Always 1. */
  version?: 1;
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
  /**
   * The page backend's entry, relative to the project root (e.g.
   * "server/index.ts"): its default export handles specola.fetch calls
   * (types in '@specola/vite-plugin/server'). Built into .specola/server/
   * after the app, and served under `vite dev` at /__specola/x/. Without it
   * the app has no backend.
   */
  server?: string;
  /** The backend's manifest; needs `server`. */
  backend?: SpecolaBackendOptions;
}

/** The Specola Vite plugin: builds the app as a Specola bundle. */
export declare function specola(options?: SpecolaOptions): Plugin;
export default specola;

/** This plugin's version. */
export declare const VERSION: string;

// window.specola, for vite.config and app code alike; app code gets it from
// '@specola/vite-plugin/client' (see client.d.ts).
export type { SpecolaBackendState, SpecolaBackendUnavailable, SpecolaRuntime } from './client.js';
