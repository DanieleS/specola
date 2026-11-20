import specola from '../../plugin/index.js';

// No import from 'vite': e2e/bundles.mjs builds this app with the plugin's
// own Vite (plugin/node_modules), so e2e/ needs no dependencies of its own.
export default {
  // Keep the font and images as files, so the test sees them load.
  build: { assetsInlineLimit: 0 },
  plugins: [specola({ searchText: 'End-to-end bundle fixture' })],
};
