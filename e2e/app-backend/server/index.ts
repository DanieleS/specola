// The e2e app's backend: a shared counter (ctx.db), a note per user
// (ctx.userDb), uploads (ctx.files), a streamed answer and a route that
// throws; then steps 3–7: whether a secret is set (never its value),
// outbound fetch through the egress proxy, push (ctx.publish), a scheduled
// job that records its runs, and public routes.

type Ctx = {
  user: { sub: string; email: string; name: string } | null;
  role: string;
  page: { id: string; version: number; title: string };
  link: { id: string; label: string } | null;
  secrets: Record<string, string>;
  publish(topic: string, data: unknown, opts?: { to?: string }): void;
  db: any;
  userDb: any;
  files: {
    put(key: string, body: unknown, opts?: { contentType?: string }): Promise<{ key: string; size: number; contentType: string }>;
    get(key: string): Promise<{ body: ReadableStream; size: number; contentType: string } | null>;
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function runs(ctx: Ctx) {
  ctx.db.exec('CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, name TEXT, scheduled_time INTEGER, role TEXT, has_user INTEGER)');
}

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
      // Secrets: whether it is there, and its length; never the value.
      case 'GET /api/secret': {
        const v = ctx.secrets.OPENAI_API_KEY;
        return Response.json({ has: typeof v === 'string', length: v?.length ?? 0, names: Object.keys(ctx.secrets), frozen: Object.isFrozen(ctx.secrets) });
      }
      // Egress: fetches ?url= through the proxy.
      case 'GET /api/egress':
        try {
          const res = await fetch(url.searchParams.get('url')!);
          return Response.json({ ok: true, status: res.status, text: await res.text() });
        } catch (err: any) {
          return Response.json({ ok: false, error: String(err?.cause?.message ?? err?.message ?? err) });
        }
      // Push: {topic, data, to?}.
      case 'POST /api/publish': {
        const { topic, data, to } = await request.json();
        ctx.publish(topic, data, to ? { to } : {});
        return new Response(null, { status: 204 });
      }
      case 'GET /api/runs':
        runs(ctx);
        return Response.json({ runs: ctx.db.prepare('SELECT name, scheduled_time AS scheduledTime, role, has_user AS hasUser FROM runs ORDER BY id').all() });
      // Public routes (backend.json "public").
      case 'GET /api/public/hello':
        return Response.json({ role: ctx.role, user: ctx.user, link: ctx.link, userDb: ctx.userDb === null });
    }
    return new Response('not found', { status: 404 });
  },

  // The job "tick", every minute: records its run in the shared database
  // and tells the page.
  async scheduled(event: { name: string; scheduledTime: number }, ctx: Ctx): Promise<void> {
    runs(ctx);
    ctx.db.prepare('INSERT INTO runs (name, scheduled_time, role, has_user) VALUES (?, ?, ?, ?)').run(event.name, event.scheduledTime, ctx.role, ctx.user ? 1 : 0);
    ctx.publish('runs', { name: event.name });
  },
};
