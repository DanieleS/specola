// The fixture's backend: a router, the shared and per-user databases, the
// file store, secrets and a streamed response.
import type { Ctx, Handler } from '@specola/vite-plugin/server';
import { greet } from './greet.ts';

function migrate(ctx: Ctx) {
  ctx.db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, by TEXT NOT NULL, body TEXT NOT NULL)');
}

const handler: Handler = {
  async fetch(request, ctx) {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /api/hello':
        return Response.json({ hello: greet(ctx.user?.name ?? 'nobody'), role: ctx.role, page: ctx.page, query: url.search, origin: url.origin, cookie: request.headers.get('cookie'), specola: request.headers.get('x-specola-version') });
      case 'POST /api/notes': {
        migrate(ctx);
        const { body } = (await request.json()) as { body: string };
        ctx.db.prepare('INSERT INTO notes (by, body) VALUES (?, ?)').run(ctx.user!.sub, body);
        return Response.json({ ok: true }, { status: 201 });
      }
      case 'GET /api/notes':
        migrate(ctx);
        return Response.json(ctx.db.prepare('SELECT by, body FROM notes ORDER BY id').all());
      case 'POST /api/mine': {
        ctx.userDb!.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)');
        ctx.userDb!.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?)').run('last', await request.text());
        return new Response(null, { status: 204 });
      }
      case 'GET /api/mine':
        return Response.json(ctx.userDb!.prepare('SELECT v FROM kv WHERE k = ?').get('last') ?? null);
      case 'PUT /api/file': {
        const info = await ctx.files.put('uploads/a.txt', request.body!, { contentType: request.headers.get('content-type') ?? undefined });
        return Response.json(info);
      }
      case 'GET /api/file': {
        const f = await ctx.files.get('uploads/a.txt');
        if (!f) return new Response('none', { status: 404 });
        return new Response(f.body, { headers: { 'content-type': f.contentType, 'x-listed': JSON.stringify(await ctx.files.list('uploads/')) } });
      }
      case 'GET /api/secret':
        return Response.json(ctx.secrets);
      case 'GET /api/cookie':
        return new Response('ok', { headers: { 'set-cookie': 'a=b', 'x-kept': 'yes' } });
      case 'GET /api/stream': {
        let n = 0;
        const stream = new ReadableStream({
          async pull(controller) {
            if (n === 3) return controller.close();
            controller.enqueue(new TextEncoder().encode(`chunk ${n++}\n`));
            await new Promise((r) => setTimeout(r, 150));
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/plain' } });
      }
      case 'GET /api/publish':
        ctx.publish('t', { x: 1 });
        return new Response('sent');
      case 'GET /api/throw':
        throw new Error('boom');
    }
    return new Response('not found', { status: 404 });
  },
};

export default handler;
