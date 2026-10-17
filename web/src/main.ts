import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";

// The worker keeps the app and what it has read available offline. Only in a
// build: in the dev server it would serve stale modules.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("service worker:", e));
}

export default mount(App, { target: document.getElementById("app")! });
