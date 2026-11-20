#!/usr/bin/env node
// specola-publish: builds the Vite app in the current directory and uploads
// it to Specola as a bundle. See `specola-publish --help`.

import { PublishError, USAGE, parseArgs, publish } from '../lib/publish.js';

try {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(USAGE);
  } else {
    const retryDelayMs = Number(process.env.SPECOLA_PUBLISH_RETRY_MS) || undefined;
    const result = await publish(opts, { retryDelayMs });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
} catch (err) {
  process.stderr.write(`specola-publish: error: ${err instanceof PublishError ? err.message : err.stack ?? err}\n`);
  process.exitCode = 1;
}
