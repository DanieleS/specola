// The e2e app's backend: a shared counter (ctx.db), a note per user
// (ctx.userDb), uploads (ctx.files), a streamed answer and a route that
// throws.

type Ctx = {
  user: { sub: string; email: string; name: string } | null;
  role: string;
  page: { id: string; version: number; title: string };
  db: any;
  userDb: any;
  files: {
    put(key: string, body: unknown, opts?: { contentType?: string }): Promise<{ key: string; size: number; contentType: string }>;
    get(key: string): Promise<{ body: ReadableStream; size: number; contentType: string } | null>;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function counter(ctx: Ctx) {
  ctx.db.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER NOT NULL)');
  ctx.db.exec('INSERT OR IGNORE INTO counter VALUES (1, 0)');
}

export default {
  async fetch(request: Request, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case 'POST /api/counter':
        counter(ctx);
        ctx.db.exec('UPDATE counter SET n = n + 1');
        return Response.json({ count: ctx.db.prepare('SELECT n FROM counter').get().n, version: ctx.page.version });
      case 'GET /api/counter':
        counter(ctx);
        return Response.json({ count: ctx.db.prepare('SELECT n FROM counter').get().n, version: ctx.page.version });
      case 'PUT /api/note':
        ctx.userDb.exec('CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT)');
        ctx.userDb.prepare('INSERT OR REPLACE INTO note VALUES (1, ?)').run(await request.text());
        return new Response(null, { status: 204 });
      case 'GET /api/note': {
        ctx.userDb.exec('CREATE TABLE IF NOT EXISTS note (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT)');
        const row = ctx.userDb.prepare('SELECT body FROM note').get();
        return Response.json({ sub: ctx.user?.sub, role: ctx.role, note: row?.body ?? null });
      }
      case 'POST /api/upload': {
        const file = (await request.formData()).get('file') as File;
        const info = await ctx.files.put(`uploads/${file.name}`, file, { contentType: file.type });
        return Response.json(info, { status: 201 });
      }
      case 'GET /api/upload': {
        const f = await ctx.files.get(`uploads/${url.searchParams.get('name')}`);
        if (!f) return new Response('no such file', { status: 404 });
        return new Response(f.body, { headers: { 'content-type': f.contentType, 'content-length': String(f.size) } });
      }
      case 'GET /api/stream': {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            for (let i = 0; i < 4; i++) {
              controller.enqueue(enc.encode(`chunk ${i}\n`));
              await sleep(400);
            }
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      case 'GET /api/throw':
        throw new Error('e2e boom');
    }
    return new Response('not found', { status: 404 });
  },
};
