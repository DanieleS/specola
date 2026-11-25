// The app: talks to its backend through specola.fetch, never by importing it.
const res = await window.specola.fetch('/api/hello');
document.getElementById('app').textContent = (await res.json()).hello;
