#!/usr/bin/env node
// A stand-in for pnpm in the runner's tests (deps.test.js): "installs" each
// dependency of ./package.json as a tiny package that says what it is.
// npm_config_fake_delay_ms makes it slow, npm_config_fake_fail makes it fail.
import fs from 'node:fs';
import path from 'node:path';

const { dependencies = {} } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const delay = Number(process.env.npm_config_fake_delay_ms || 0);
await new Promise((r) => setTimeout(r, delay));
if (process.env.npm_config_fake_fail) {
  console.error('ERR_PNPM_FETCH_404 GET https://registry.invalid/nope: Not Found - 404');
  process.exit(1);
}
fs.appendFileSync(path.join(path.dirname(process.cwd()), 'installs.log'), JSON.stringify({ args: process.argv.slice(2), dependencies, home: process.env.HOME, token: process.env.SPECOLA_RUNNER_TOKEN ?? null }) + '\n');
for (const [name, version] of Object.entries(dependencies)) {
  const dir = path.join('node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, main: 'index.js', exports: { '.': './index.js', './sub': './sub.js' } }));
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} };\n`);
  fs.writeFileSync(path.join(dir, 'sub.js'), `module.exports = 'sub of ${name}';\n`);
}
console.log(`Done: ${Object.keys(dependencies).length} packages`);
