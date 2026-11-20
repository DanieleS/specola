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
}

declare global {
  interface Window {
    specola?: SpecolaRuntime;
  }
}
