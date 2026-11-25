// Realtime push, the runner's half (docs/page-backends.md, "Realtime push
// (step 4)"): ctx.publish's checks in the worker, the per-page rate, and
// the posts to specola's /internal/runner/publish (a fake one here), with
// retries that never hold the handler up.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Logs } from '../src/log.js';
import { MAX_PUSH_DATA, Publisher, pushProblem } from '../src/push.js';
import { backend, logText, startRunner, until } from './helpers.js';

describe('ctx.publish in a worker', () => {
  let r;
  before(async () => {
    r = await startRunner({}, { publish: { backoffMs: 10 } });
  });
  after(() => r.close());

  test('a push reaches specola with the page, topic, data and recipient', async () => {
    const v = r.publish(
      backend(`export default {
        fetch(request, ctx) {
          ctx.publish('orders', { added: 1, by: ctx.user.sub, text: 'é<>&' });
          ctx.publish('a/b:c.d-e_f', null, { to: 'user-2' });
          ctx.publish('n', 42, {});
          return new Response('ok');
        },
      }`),
    );
    assert.equal(await (await r.invoke({ ...v, page: 'push-1' })).text(), 'ok');
    await r.runner.publisher.idle();
    const got = r.specola.pushes.filter((p) => p.body.page === 'push-1');
    // Sent up to 4 at once: the order they arrive in may vary.
    const byTopic = (a, b) => (a.topic < b.topic ? -1 : 1);
    assert.deepEqual(
      got.map((p) => p.body).sort(byTopic),
      [
        { page: 'push-1', topic: 'orders', data: { added: 1, by: 'user-1', text: 'é<>&' } },
        { page: 'push-1', topic: 'a/b:c.d-e_f', data: null, to: 'user-2' },
        { page: 'push-1', topic: 'n', data: 42 },
      ].sort(byTopic),
    );
    assert.equal(got[0].type, 'application/json');
    // The fake answers 404 to a wrong token: these went with the runner's.
    assert.ok(got.every((p) => p.status === 204));
  });

  test('invalid pushes throw TypeError in the handler', async () => {
    const v = r.publish(
      backend(`export default {
        fetch(request, ctx) {
          const circular = {}; circular.self = circular;
          const cases = {
            emptyTopic: () => ctx.publish('', 1),
            badTopic: () => ctx.publish('has space', 1),
            longTopic: () => ctx.publish('t'.repeat(129), 1),
            numberTopic: () => ctx.publish(5, 1),
            undefinedData: () => ctx.publish('t', undefined),
            fnData: () => ctx.publish('t', () => 1),
            circular: () => ctx.publish('t', circular),
            bigint: () => ctx.publish('t', 1n),
            tooLarge: () => ctx.publish('t', 'x'.repeat(${MAX_PUSH_DATA - 1})),
            badTo: () => ctx.publish('t', 1, { to: 5 }),
            emptyTo: () => ctx.publish('t', 1, { to: '' }),
            badOpts: () => ctx.publish('t', 1, 'user-2'),
          };
          const out = {};
          for (const [k, f] of Object.entries(cases)) {
            try { f(); out[k] = 'ok'; } catch (err) { out[k] = err.constructor.name + ': ' + err.message; }
          }
          // Exactly the limit is fine (the quotes count).
          ctx.publish('t', 'x'.repeat(${MAX_PUSH_DATA - 2}));
          ctx.publish('t'.repeat(128), 1);
          return Response.json(out);
        },
      }`),
    );
    const out = await (await r.invoke({ ...v, page: 'push-2' })).json();
    for (const [k, v] of Object.entries(out)) assert.match(v, /^TypeError: ctx\.publish: /, k);
    assert.match(out.tooLarge, /7169 bytes serialised; at most 7168/);
    assert.match(out.badTopic, /letters, digits/);
    await r.runner.publisher.idle();
    const got = r.specola.pushes.filter((p) => p.body.page === 'push-2');
    assert.equal(got.length, 2);
    assert.equal(Buffer.byteLength(JSON.stringify(got.find((p) => p.body.topic === 't').body.data)), MAX_PUSH_DATA);
  });

  test('publishing from a scheduled run, and from waitUntil after the response', async () => {
    const v = r.publish(
      backend(`export default {
        fetch(request, ctx) {
          ctx.waitUntil(new Promise((r) => setTimeout(r, 100)).then(() => ctx.publish('late', 'after')));
          return new Response('ok');
        },
        scheduled(event, ctx) { ctx.publish('cron', { job: event.name }); },
      }`),
    );
    await (await r.invoke({ ...v, page: 'push-3' })).text();
    assert.deepEqual(await (await r.scheduled({ ...v, page: 'push-3', name: 'tick' })).json(), { status: 'ok' });
    await until(() => r.specola.pushes.filter((p) => p.body.page === 'push-3').length === 2);
    const topics = r.specola.pushes.filter((p) => p.body.page === 'push-3').map((p) => [p.body.topic, p.body.data]);
    assert.deepEqual(topics.sort(), [
      ['cron', { job: 'tick' }],
      ['late', 'after'],
    ]);
  });

  test('more than 50 a second: the rest are dropped, with one warning', async () => {
    const v = r.publish(
      backend(`export default {
        fetch(request, ctx) {
          for (let i = 0; i < 200; i++) ctx.publish('burst', i);
          return new Response('ok');
        },
      }`),
    );
    const t0 = Date.now();
    await (await r.invoke({ ...v, page: 'push-4' })).text();
    await r.runner.publisher.idle();
    const elapsed = Date.now() - t0;
    const got = r.specola.pushes.filter((p) => p.body.page === 'push-4');
    // The bucket holds 50, refilled at 50 a second while the burst arrives.
    assert.ok(got.length >= 50 && got.length <= 50 + Math.ceil((elapsed / 1000) * 50) + 1, `${got.length} in ${elapsed} ms`);
    assert.deepEqual(
      got.map((p) => p.body.data).sort((a, b) => a - b).slice(0, 50),
      Array.from({ length: 50 }, (_, i) => i),
    );
    const warnings = (await logText(r, 'push-4')).split('\n').filter((l) => /more than 50 publishes a second/.test(l));
    assert.ok(warnings.length >= 1 && warnings.length <= Math.ceil(elapsed / 1000) + 1, warnings.join('\n'));
    assert.match(warnings[0], /^\[warn\] ctx\.publish: more than 50 publishes a second on this page; pushes over the rate are dropped/);
  });

  test('the handler never waits for specola, and failures are retried with backoff', async () => {
    r.specola.publishStatus.push(503, 502);
    const v = r.publish(
      backend(`export default {
        fetch(request, ctx) { ctx.publish('retry', 'x'); return new Response('ok'); },
      }`),
    );
    assert.equal(await (await r.invoke({ ...v, page: 'push-5' })).text(), 'ok');
    await r.runner.publisher.idle();
    const got = r.specola.pushes.filter((p) => p.body.page === 'push-5');
    assert.deepEqual(
      got.map((p) => p.status),
      [503, 502, 204],
    );
    assert.doesNotMatch(await logText(r, 'push-5'), /ctx\.publish/);
  });

  test('a refusal is not retried, and is in the log', async () => {
    r.specola.publishStatus.push(413);
    const v = r.publish(
      backend(`export default {
        fetch(request, ctx) { ctx.publish('refused', 'x'); return new Response('ok'); },
      }`),
    );
    await (await r.invoke({ ...v, page: 'push-6' })).text();
    await r.runner.publisher.idle();
    assert.equal(r.specola.pushes.filter((p) => p.body.page === 'push-6').length, 1);
    assert.match(await logText(r, 'push-6'), /\[error\] ctx\.publish to "refused": not delivered: specola answered 413 body-too-large: refused by the test/);
  });

  test('page code sending its own publish message cannot get past the checks', async () => {
    const v = r.publish(
      backend(`export default {
        fetch() {
          process.send({ t: 'publish', topic: 'bad topic', data: '1' });
          process.send({ t: 'publish', topic: 'ok', data: 'not json' });
          process.send({ t: 'publish', topic: 'ok', data: '1', to: 7 });
          process.send({ t: 'publish', topic: 'ok', data: JSON.stringify('x'.repeat(8000)) });
          return new Response('ok');
        },
      }`),
    );
    assert.equal(await (await r.invoke({ ...v, page: 'push-7' })).text(), 'ok');
    await until(async () => /ctx\.publish: a push was dropped: the topic is invalid/.test(await logText(r, 'push-7')));
    await r.runner.publisher.idle();
    assert.equal(r.specola.pushes.filter((p) => p.body.page === 'push-7').length, 0);
  });
});

describe('Publisher', () => {
  const make = (fetch, options = {}) => {
    const logs = new Logs();
    const clock = { t: 1_000_000 };
    const p = new Publisher({ specolaUrl: 'http://specola.invalid', token: 'tok', fetch, logs, now: () => clock.t, options: { backoffMs: 1, ...options } });
    const lines = (page = 'p') => logs.since(page).map((l) => `[${l.level}] ${l.text}`);
    return { p, logs, clock, lines };
  };
  const ok = async () => new Response(null, { status: 204 });

  test('pushProblem', () => {
    assert.equal(pushProblem({ topic: 't', data: '1' }), null);
    assert.equal(pushProblem({ topic: 't', data: '{"a":1}', to: 'sub' }), null);
    assert.match(pushProblem({ topic: '', data: '1' }), /topic/);
    assert.match(pushProblem({ topic: 't', data: 1 }), /not serialised JSON/);
    assert.match(pushProblem({ topic: 't', data: '{' }), /not serialised JSON/);
    assert.match(pushProblem({ topic: 't', data: JSON.stringify('x'.repeat(MAX_PUSH_DATA)) }), /larger than/);
    assert.match(pushProblem({ topic: 't', data: '1', to: '' }), /to is invalid/);
    assert.match(pushProblem({ topic: 't', data: '1', to: 'x'.repeat(2000) }), /to is invalid/);
  });

  test('the token bucket: 50, refilled at 50 a second; one warning a second', async () => {
    const sent = [];
    const { p, clock, lines } = make(async (url, init) => {
      sent.push(JSON.parse(init.body).data);
      return ok();
    });
    for (let i = 0; i < 60; i++) p.publish('p', { topic: 't', data: String(i) });
    await p.idle();
    assert.equal(sent.length, 50);
    assert.deepEqual(lines(), ['[warn] ctx.publish: more than 50 publishes a second on this page; pushes over the rate are dropped']);
    // 100 ms later: 5 more tokens.
    clock.t += 100;
    for (let i = 0; i < 10; i++) p.publish('p', { topic: 't', data: '0' });
    await p.idle();
    assert.equal(sent.length, 55);
    assert.equal(lines().length, 1, 'still within the second');
    clock.t += 1000;
    for (let i = 0; i < 60; i++) p.publish('p', { topic: 't', data: '0' });
    await p.idle();
    assert.equal(sent.length, 105);
    assert.equal(lines().length, 2);
    // Held back since the first line: 9 of the first burst, 5 of the second.
    assert.match(lines()[1], /dropped \(and 14 more since the last such line\)$/);
    // Another page has its own bucket.
    p.publish('q', { topic: 't', data: '0' });
    await p.idle();
    assert.equal(sent.length, 106);
  });

  test('the body, the token and the URL', async () => {
    const calls = [];
    const { p } = make(async (url, init) => {
      calls.push({ url, init });
      return ok();
    });
    p.publish('page-x', { topic: 'a', data: '{"k":[1,2]}', to: 'sub-1' });
    await p.idle();
    assert.equal(calls[0].url, 'http://specola.invalid/internal/runner/publish');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
    assert.equal(calls[0].init.body, '{"page":"page-x","topic":"a","data":{"k":[1,2]},"to":"sub-1"}');
  });

  test('an unreachable specola: retried, then given up with one log line', async () => {
    let n = 0;
    const { p, lines } = make(
      async () => {
        n++;
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      },
      { attempts: 3 },
    );
    p.publish('p', { topic: 't', data: '1' });
    p.publish('p', { topic: 't', data: '2' });
    await p.idle();
    assert.equal(n, 6);
    // Two give-ups in the same second: one line.
    assert.deepEqual(lines(), ['[error] ctx.publish to "t": not delivered: specola could not be reached (ECONNREFUSED)']);
  });

  test('a full queue drops, and publish never throws or waits', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const { p, lines } = make(async () => {
      await gate;
      return ok();
    }, { queueMax: 3, concurrency: 1 });
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) p.publish('p', { topic: 't', data: '1' });
    assert.ok(Date.now() - t0 < 50);
    assert.deepEqual(lines(), ['[warn] ctx.publish: specola is not taking pushes fast enough; a push was dropped']);
    release();
    await p.idle();
  });

  test('close drops what is pending', async () => {
    let n = 0;
    const { p } = make(async (url, init) => {
      n++;
      await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    });
    p.publish('p', { topic: 't', data: '1' });
    p.publish('p', { topic: 't', data: '2' });
    p.close();
    p.publish('p', { topic: 't', data: '3' });
    await p.idle();
    assert.ok(n <= 2);
  });
});
