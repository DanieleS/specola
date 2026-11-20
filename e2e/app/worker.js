import { double } from './math.js';

self.onmessage = (e) => self.postMessage(double(e.data));
