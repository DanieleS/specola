import './style.css';
import { shared } from './shared.js';
import dataUrl from './data.json?url';

const app = document.getElementById('app');
app.textContent = shared('main');

document.getElementById('app').addEventListener('click', async () => {
  const { lazy } = await import('./lazy.js');
  app.textContent = lazy();
});

const worker = new Worker(new URL('./worker.js', import.meta.url));
worker.onmessage = (e) => console.log('worker said', e.data);
worker.postMessage(21);

fetch(dataUrl)
  .then((r) => r.json())
  .then((data) => console.log(data.greeting));

// A root-absolute reference to a public/ file: the plugin must warn about it.
const logo = document.createElement('img');
logo.src = '/logo.png';
document.body.append(logo);

// An external SVG sprite: blank in a bundle, so the plugin must warn about it.
document.body.insertAdjacentHTML('beforeend', '<svg><use href="/sprite.svg#dot"></use></svg>');
