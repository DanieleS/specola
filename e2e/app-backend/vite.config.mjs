import specola from '../../plugin/index.js';

// No import from 'vite': e2e/backends.mjs builds this app with the plugin's
// own Vite (plugin/node_modules), so e2e/ needs no dependencies of its own.
//
// The manifest uses every field (docs/page-backends.md, steps 3–7): a
// secret, an egress host (e2e/backends.mjs serves "localhost" itself, with
// the runner's loopback allowance for tests), a job every minute, public
// routes and a public topic.
export default {
  plugins: [
    specola({
      server: 'server/index.ts',
      backend: {
        secrets: ['OPENAI_API_KEY'],
        egress: ['localhost'],
        cron: [{ name: 'tick', schedule: '* * * * *' }],
        public: ['GET /api/public/*'],
        topics: { public: ['news'] },
      },
    }),
  ],
};
