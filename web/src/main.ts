import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import AppShell from "./lib/AppShell.svelte";
import { listenForInstall } from "./lib/install.svelte";

// The worker keeps the app and what it has read available offline. Only in a
// build: in the dev server it would serve stale modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker:", e));
}

// Before anything mounts: the browser offers installing once, early.
listenForInstall();

// A page installed as an app (docs/page-apps.md) is at /app/{id}/; anything
// else is Specola.
const app = /^\/app\/([^/]+)\/$/.exec(location.pathname);
const target = document.getElementById("app")!;

export default app ? mount(AppShell, { target, props: { id: decodeURIComponent(app[1]) } }) : mount(App, { target });
