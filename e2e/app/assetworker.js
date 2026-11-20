// A worker that finds its own files the way Vite compiles it: a ?url import
// and new URL(…, import.meta.url) both become new URL(file, self.location.href).
import textUrl from './worker-data.txt?url';

self.onmessage = async () => {
  const viaImport = (await (await fetch(textUrl)).text()).trim();
  const viaURL = (await (await fetch(new URL('./worker-data.txt', import.meta.url))).text()).trim();
  self.postMessage({ viaImport, viaURL, location: String(self.location.href) });
};
