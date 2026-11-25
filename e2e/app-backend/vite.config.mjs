import specola from '../../plugin/index.js';

// No import from 'vite': e2e/backends.mjs builds this app with the plugin's
// own Vite (plugin/node_modules), so e2e/ needs no dependencies of its own.
export default {
  plugins: [specola({ server: 'server/index.ts', backend: {} })],
};
