// The runner's entry point: configuration from the environment, then serve
// until SIGTERM/SIGINT, stopping the page workers on the way out.

import { loadConfig, nodeVersionProblem } from './config.js';
import { createRunner, RUNNER_VERSION } from './server.js';

// Refuse an old Node before anything else: there, workers' egress would be
// open whatever their egress list says.
const tooOld = nodeVersionProblem(process.versions.node);
if (tooOld) {
  console.error(`specola-runner: ${tooOld}`);
  process.exit(2);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`specola-runner: ${err.message}`);
  process.exit(2);
}

if (config.egressAllowLoopbackForTests) {
  console.warn('specola-runner: WARNING: RUNNER_EGRESS_ALLOW_LOOPBACK_FOR_TESTS=1, page code may reach this host through the egress proxy; for tests only');
}
const runner = createRunner(config);
await runner.sweep();
let addr;
try {
  addr = await runner.listen();
} catch (err) {
  // The listener, or the egress proxy (without which no worker may start).
  console.error(`specola-runner: ${err.message}`);
  process.exit(1);
}
const proxy = await runner.egress();
console.log(`specola-runner ${RUNNER_VERSION} listening on ${addr.address}:${addr.port}, data in ${config.dataDir}; egress proxy on 127.0.0.1:${proxy.port}`);

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
