import { defineConfig } from 'vite';
import specola from '../../index.js';

// Used by hand (npx vite build in this directory); the tests pass the same
// settings inline so they can vary the plugin options.
export default defineConfig({
  build: { assetsInlineLimit: 0 },
  plugins: [specola({ searchText: 'Fixture app <for> tests & such' })],
});
