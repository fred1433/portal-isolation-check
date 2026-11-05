// A deterministic HTTP client: each Browser has its own cookie jar, like two
// separate browsers on two separate machines. No network, no model, no cost.
import { DatabaseSync } from 'node:sqlite';
import { applySchema, type Db, type Row } from '../src/db.ts';
import { handle } from '../src/portal.ts';
import { seedDemo, type Seed } from '../src/seed.ts';

export function memoryDb(): Db {
  const d = new DatabaseSync(':memory:');
  return {
    all: (sql, ...params) => d.prepare(sql).all(...(params as never[])) as Row[],
    run: (sql, ...params) => {
      d.prepare(sql).run(...(params as never[]));
    },
  };
}

type App = (req: Request) => Promise<Response>;

export class Browser {
  jar = new Map<string, string>();
  app: App;
  identity = '';
  constructor(app: App) {
    this.app = app;
  }
  async request(method: string, path: string, init: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    // An explicit cookie header replaces the jar (used to present a forged cookie).
    if (this.jar.size && !headers.cookie) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.app(new Request(`http://portal.test${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }));
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      this.jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  }
  get(path: string, headers?: Record<string, string>) {
    return this.request('GET', path, { headers });
  }
  post(path: string, body: unknown) {
    return this.request('POST', path, { body });
  }
  async signIn(identity: string) {
    const res = await this.post('/api/sessions', { identities: [identity] });
    if (res.status !== 200) throw new Error(`sign-in as ${identity} failed: ${res.status}`);
    this.identity = identity;
    return (await res.json()).sessions[0] as { identity: string; label: string; role: string; ref: string };
  }
}

export class ServiceClient {
  app: App;
  token: string;
  constructor(app: App, token: string) {
    this.app = app;
    this.token = token;
  }
  request(method: string, path: string, body?: unknown) {
    return this.app(new Request(`http://portal.test${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  }
}

export async function setup() {
  const db = memoryDb();
  applySchema(db);
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 5, 9, 0, tick++)).toISOString();
  const seed: Seed = await seedDemo(db, now());
  const app: App = (req) => handle(req, { db, now });
  const as = async (identity: string) => {
    const b = new Browser(app);
    await b.signIn(identity);
    return b;
  };
  return { db, seed, app, as, hermes: new ServiceClient(app, seed.hermesToken) };
}

export async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}
