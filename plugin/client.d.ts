// Types for app code: window.specola, the runtime Specola gives every page.
// Add them to the app's TypeScript program (the plugin's main entry is only
// seen by vite.config), in src/vite-env.d.ts:
//   /// <reference types="@specola/vite-plugin/client" />
// or in tsconfig.app.json: "types": ["vite/client", "@specola/vite-plugin/client"]

/** What Specola's page SDK provides at runtime (and the plugin, under `vite dev`). */
export interface SpecolaRuntime {
  /** The URL the bundle's files are served under, ending in "/" ("/" in dev, "" for plain pages). */
  readonly base: string;
  /** The path prefix the page is served under, for client-side routers ("" in dev). */
  readonly basename: string;
  /** Whether localStorage writes are saved by Specola. */
  readonly persistent: boolean;
  /** Resolves once every localStorage write so far is saved (rejects if one was refused). */
  flush(): Promise<void>;
  /**
   * Calls the page's backend (the plugin's `server` option), with fetch's
   * signature. input is a path starting with "/", or a URL or Request on the
   * page's own origin (anything else rejects with a TypeError); the response
   * streams. Rejects with a BackendUnavailable error when the backend can't
   * be reached (see SpecolaBackendUnavailable).
   * Under `vite dev` it goes to the plugin's dev backend.
   */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /**
   * Whether backends are enabled on this Specola instance and the runner
   * answers right now: {enabled: false, available: false} on a page without
   * a backend, and until the viewer has said.
   */
  readonly backend: SpecolaBackendState;
}

export interface SpecolaBackendState {
  readonly enabled: boolean;
  readonly available: boolean;
}

/** What specola.fetch rejects with when the backend can't be reached. */
export interface SpecolaBackendUnavailable extends Error {
  readonly name: 'BackendUnavailable';
  /**
   * disabled: the instance has no backend runner (or the app no server);
   * unavailable: the runner is not answering; superseded: a newer version of
   * the page is current (reload); offline: no network.
   */
  readonly reason: 'disabled' | 'unavailable' | 'superseded' | 'offline';
}

declare global {
  interface Window {
    specola?: SpecolaRuntime;
  }
}
