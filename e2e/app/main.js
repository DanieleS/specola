// Runs every check docs/spa-bundles.md promises a bundle and publishes the
// results as window.__e2e (and in the page, for a human looking at it);
// e2e/bundles.mjs reads them from the sandboxed frame.
import './style.css';
import { label } from './shared.js';
import dataUrl from './data.json?url';
import logoUrl from './assets/logo.svg?url';

const results = {};
window.__e2e = results;

// worker answers one message, and reports whether the wrapper kept
// instanceof Worker working.
function ask(w) {
  return new Promise((resolve, reject) => {
    w.onmessage = (e) => resolve({ value: e.data, isWorker: w instanceof Worker });
    w.onerror = (e) => reject(new Error('worker error: ' + (e.message || 'failed to start')));
    w.postMessage(21);
  });
}

const checks = {
  render: () => {
    document.getElementById('app').textContent = label('rendered');
    return document.getElementById('app').textContent;
  },
  lazy: async () => (await import('./lazy.js')).lazy(),
  worker: () => ask(new Worker(new URL('./worker.js', import.meta.url))),
  // The SDK drops type: "module" for an http(s) URL, with a warning.
  moduleWorker: () => ask(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })),
  // A blob: worker the page makes itself is passed through untouched.
  blobWorker: () => {
    const src = 'onmessage = (e) => postMessage(e.data * 3)';
    return ask(new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))));
  },
  json: async () => (await (await fetch(dataUrl)).json()).greeting,
  image: () =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img.naturalWidth);
      img.onerror = () => reject(new Error('image failed: ' + logoUrl));
      img.src = logoUrl;
      document.body.append(img);
    }),
  storage: () => {
    localStorage.setItem('e2e', 'kept');
    return { value: localStorage.getItem('e2e'), persistent: window.specola.persistent };
  },
  specola: () => ({ base: window.specola.base, basename: window.specola.basename, path: location.pathname }),
};

const list = document.getElementById('results');
await Promise.all(
  Object.entries(checks).map(async ([name, check]) => {
    try {
      results[name] = { ok: true, value: await check() };
    } catch (err) {
      results[name] = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    const li = document.createElement('li');
    li.textContent = `${name}: ${JSON.stringify(results[name])}`;
    list.append(li);
  }),
);
document.documentElement.dataset.e2e = 'done';
