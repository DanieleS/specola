import { label } from './shared.js';
// CSS of a lazy chunk: Vite loads it with the chunk (offline too, from the
// kept copy), before import() resolves.
import './lazy.css';

export const lazy = () => {
  const el = document.createElement('span');
  el.id = 'lazy-styled';
  document.body.append(el);
  return `${label('lazy chunk')}|${getComputedStyle(el).color}`;
};
