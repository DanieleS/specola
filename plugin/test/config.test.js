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
  assert.match(client, /fetch\(input: string \| URL \| Request, init\?: RequestInit\): Promise<Response>;/);
  assert.match(client, /readonly backend: SpecolaBackendState;/);
  assert.match(client, /subscribe<T = unknown>\(topic: string, onMessage: \(data: T, topic: string\) => void\): \(\) => void;/);
  assert.match(server, /export type Role = 'owner' \| 'editor' \| 'viewer' \| 'public' \| 'cron';/);
  assert.match(server, /readonly secrets: Readonly<Record<string, string>>;/);
  assert.match(server, /publish\(topic: string, data: unknown, opts\?: \{ to\?: string \}\): void;/);
  assert.match(server, /readonly link: LinkInfo \| null;/);
  assert.match(server, /scheduled\?\(event: ScheduledEvent, ctx: Ctx\): void \| Promise<void>;/);
  assert.match(server, /export interface ScheduledEvent \{[^}]*readonly name: string;[^}]*readonly scheduledTime: number;/);
  assert.doesNotMatch(server + client, /not available yet/i);
});

// The types compile, and catch what they should, when the repository's web
// app has TypeScript and @types/node installed (they are not the plugin's
// dependencies); skipped otherwise.
test('the server and client types check with TypeScript', async (t) => {
  const { createRequire } = await import('node:module');
  const { existsSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const web = fileURLToPath(new URL('../../web/', import.meta.url));
  if (!existsSync(join(web, 'node_modules/typescript')) || !existsSync(join(web, 'node_modules/@types/node'))) {
    t.skip('no TypeScript or @types/node in ../web/node_modules');
    return;
  }
  const ts = createRequire(join(web, 'package.json'))('typescript');
  const dir = mkdtempSync(join(tmpdir(), 'specola-types-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plugin = fileURLToPath(new URL('../', import.meta.url));
  const good = join(dir, 'good.ts');
  const bad = join(dir, 'bad.ts');
  // A reference by path: "types" references don't go through paths.
  writeFileSync(
    good,
    `/// <reference path=${JSON.stringify(join(plugin, 'client.d.ts'))} />
import type { Handler, Role, ScheduledEvent } from '@specola/vite-plugin/server';
const roles: Role[] = ['owner', 'editor', 'viewer', 'public', 'cron'];
export default {
  async fetch(request, ctx) {
    const key: string | undefined = ctx.secrets.OPENAI_API_KEY;
    ctx.publish('scores', { n: 1 });
    ctx.publish('scores', { n: 2 }, { to: ctx.user?.sub });
    const label: string | undefined = ctx.link?.label;
    return Response.json({ key, label, roles, path: new URL(request.url).pathname });
  },
  async scheduled(event: ScheduledEvent, ctx) {
    const when: number = event.scheduledTime;
    ctx.db.prepare('SELECT ?').get(event.name + when);
    if (ctx.role === 'cron' && ctx.user === null && ctx.userDb === null) ctx.log.info('cron');
  },
} satisfies Handler;
const stop: () => void = window.specola!.subscribe<{ n: number }>('scores', (data, topic) => console.log(data.n + 1, topic.length));
stop();
`,
  );
  writeFileSync(
    bad,
    `import type { Handler } from '@specola/vite-plugin/server';
export default {
  scheduled(event, ctx) {
    ctx.publish(1, {});
    const s: number = event.name;
  },
} satisfies Handler;
`,
  );
  const options = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: ['node'],
    typeRoots: [join(web, 'node_modules/@types')],
    baseUrl: dir,
    paths: { '@specola/vite-plugin/server': [join(plugin, 'server.d.ts')], '@specola/vite-plugin/client': [join(plugin, 'client.d.ts')] },
    skipLibCheck: true,
  };
  const diags = (file) =>
    ts.getPreEmitDiagnostics(ts.createProgram([file], options)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  assert.deepEqual(diags(good), []);
  const errors = diags(bad);
  assert.ok(errors.some((e) => /'number' is not assignable to parameter of type 'string'/.test(e)), errors.join('\n'));
  assert.ok(errors.some((e) => /'string' is not assignable to type 'number'/.test(e)), errors.join('\n'));
});
