// The app: counts its visits through its backend (specola.fetch, never an
// import of the server code). e2e/backends.mjs drives the rest from the frame.
const out = document.getElementById('count');
try {
  const res = await window.specola.fetch('/api/counter', { method: 'POST' });
  out.textContent = String((await res.json()).count);
  document.documentElement.dataset.e2e = 'ready';
} catch (err) {
  out.textContent = `${err.name}: ${err.message}`;
  window.__e2eError = { name: err.name, reason: err.reason, message: err.message };
  document.documentElement.dataset.e2e = 'failed';
}
