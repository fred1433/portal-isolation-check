// Cloudflare Worker hosting the prototype. Each visitor gets a private
// sandbox (one Durable Object with its own SQLite database), seeded with the
// fictional records and erased 24 hours after it was created.
import { DurableObject } from 'cloudflare:workers';
import { applySchema, hasSchema, type Db, type Row } from '../src/db.ts';
import { handle, isNavigation, refusalPage } from '../src/portal.ts';
import { seedDemo } from '../src/seed.ts';
import { randomToken } from '../src/util.ts';

type Env = {
  SANDBOX: DurableObjectNamespace;
  ASSETS?: Fetcher;
  BASE_PATH?: string;
  COMMIT?: string;
};

const SANDBOX_TTL_MS = 24 * 60 * 60 * 1000;

export class Sandbox extends DurableObject<Env> {
  db: Db;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.db = {
      all: (q, ...p) => sql.exec(q, ...(p as SqlStorageValue[])).toArray() as Row[],
      run: (q, ...p) => {
        sql.exec(q, ...(p as SqlStorageValue[])).toArray();
      },
    };
    ctx.blockConcurrencyWhile(async () => {
      if (!hasSchema(this.db)) {
        applySchema(this.db);
        await seedDemo(this.db, new Date().toISOString());
        await ctx.storage.setAlarm(Date.now() + SANDBOX_TTL_MS);
      }
    });
  }
  async fetch(request: Request): Promise<Response> {
    return handle(request, { db: this.db, base: this.env.BASE_PATH ?? '', secureCookies: true });
  }
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src 'self' blob:; object-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function withHeaders(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

function cookie(req: Request, name: string): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([A-Za-z0-9_-]{20,64})`));
  return m ? m[1] : null;
}

async function route(request: Request, env: Env): Promise<Response> {
  const base = env.BASE_PATH ?? '';
  const url = new URL(request.url);
  if (base && url.pathname === base) return Response.redirect(`${url.origin}${base}/`, 308);
  if (base && !url.pathname.startsWith(`${base}/`)) return new Response('Not found', { status: 404 });
  const path = url.pathname.slice(base.length) || '/';

  if (path === '/api/version') {
    return Response.json({ commit: env.COMMIT ?? 'dev' }, { headers: { 'cache-control': 'no-store' } });
  }
  if (path.startsWith('/api/') || path.startsWith('/files/')) {
    let sandbox = cookie(request, 'sbx');
    let fresh = false;
    if (request.method === 'POST' && path === '/api/sessions' && (!sandbox || url.searchParams.get('fresh') === '1')) {
      sandbox = randomToken();
      fresh = true;
    }
    if (!sandbox) {
      if (path.startsWith('/files/') && isNavigation(request)) return refusalPage(401);
      return Response.json({ error: 'no_sandbox' }, { status: 401, headers: { 'cache-control': 'no-store' } });
    }
    const stub = env.SANDBOX.get(env.SANDBOX.idFromName(sandbox));
    const res = await stub.fetch(request);
    if (!fresh) return res;
    const out = new Response(res.body, res);
    out.headers.append('set-cookie', `sbx=${sandbox}; Path=${base || '/'}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`);
    return out;
  }
  if (!env.ASSETS) return new Response('This repository ships the routes and their tests; see README.', { status: 404 });
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin), request));
  const out = new Response(res.body, res);
  const loc = out.headers.get('location');
  if (loc && loc.startsWith('/')) out.headers.set('location', base + loc);
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return withHeaders(await route(request, env));
  },
};
