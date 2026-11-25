// The runner's entry point: configuration from the environment, then serve
// until SIGTERM/SIGINT, stopping the page workers on the way out.

import { loadConfig } from './config.js';
import { createRunner, RUNNER_VERSION } from './server.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`specola-runner: ${err.message}`);
  process.exit(2);
}

const runner = createRunner(config);
await runner.code.sweep();
const addr = await runner.listen();
console.log(`specola-runner ${RUNNER_VERSION} listening on ${addr.address}:${addr.port}, data in ${config.dataDir}`);

let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    console.log(`specola-runner: ${sig}, stopping`);
    await runner.close();
    process.exit(0);
  });
}
