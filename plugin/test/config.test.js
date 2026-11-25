// The Vite config the plugin sets (docs/spa-bundles.md, Plugin behaviour).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import specola from '../index.js';

const configFor = (viteVersion) => specola().config.call(viteVersion ? { meta: { viteVersion } } : {}, {});

test('base is relative and workers are classic scripts', () => {
  for (const v of [undefined, '5.4.21', '6.4.6', '7.1.0', '8.3.8']) {
    const c = configFor(v);
    assert.equal(c.base, './', v);
    assert.equal(c.worker.format, 'iife', v);
  }
});

test("a worker's dynamic imports are inlined, the way each Vite version takes it", () => {
  // Rollup (Vite 5 to 7; Vite 5 and 6 don't say their version to plugins)
  // fails an iife build that splits code unless told to inline.
  for (const v of [undefined, '5.4.21', '6.4.6', '7.1.0']) {
    assert.deepEqual(configFor(v).worker.rollupOptions, { output: { inlineDynamicImports: true } }, v);
  }
  // Rolldown (Vite 8) inlines on its own, and deprecates inlineDynamicImports.
  assert.equal(configFor('8.3.8').worker.rollupOptions, undefined);
});

test("app code gets window.specola's types from '@specola/vite-plugin/client'", async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./client'].types, './client.d.ts');
  assert.ok(pkg.files.includes('client.d.ts'));
  const client = readFileSync(new URL('../client.d.ts', import.meta.url), 'utf8');
  assert.match(client, /declare global \{\s*interface Window \{\s*specola\?: SpecolaRuntime;/);
  // The plugin's own types (vite.config) see it too.
  assert.match(readFileSync(new URL('../index.d.ts', import.meta.url), 'utf8'), /<reference path="\.\/client\.d\.ts" \/>/);
});

test("a backend gets its types from '@specola/vite-plugin/server'", async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.exports['./server'].types, './server.d.ts');
  assert.ok(pkg.files.includes('server.d.ts'));
  const server = readFileSync(new URL('../server.d.ts', import.meta.url), 'utf8');
  for (const name of ['Ctx', 'Handler', 'FileStore', 'User', 'PageInfo', 'LinkInfo', 'Role']) {
    assert.match(server, new RegExp(`export (interface|type) ${name}\\b`), name);
  }
  const client = readFileSync(new URL('../client.d.ts', import.meta.url), 'utf8');
  assert.match(client, /fetch\(input: string, init\?: RequestInit\): Promise<Response>;/);
  assert.match(client, /readonly backend: SpecolaBackendState;/);
  assert.doesNotMatch(client, /subscribe/, 'push is not available yet');
});
