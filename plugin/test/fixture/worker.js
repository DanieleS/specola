import { double } from './math.js';

// A dynamic import in a worker: it must end up inside the classic worker script.
self.onmessage = async (e) => {
  const { triple } = await import('./triple.js');
  self.postMessage([double(e.data), triple(e.data)]);
};
