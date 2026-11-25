import specola from '../../index.js';

export default {
  plugins: [specola({ server: 'server/index.ts', backend: { public: ['get /api/hello'], secrets: ['API_KEY'] } })],
};
