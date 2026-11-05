// HTTP routes on Web-standard Request/Response, so the same handler can sit
// behind a Next.js route handler, a Worker or the tests.
import type { Db, Row } from './db.ts';
import { mayAdminister, mayRead, type Actor, type Role } from './policy.ts';
import { addDocument } from './seed.ts';
import { asBytes, fromBase64, parseCookies, randomToken, rid, sha256hex } from './util.ts';

export type Ctx = {
  db: Db;
  base?: string; // path prefix in front of the routes, e.g. /demos/x
  now?: () => string;
  secureCookies?: boolean;
};

const NO_STORE = { 'cache-control': 'no-store' };

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...NO_STORE, ...extra },
  });
}

// A refused read and a read of a file that does not exist get the same
// answer: no name, no size, no preview, only the id of the audit row.
function refused(attempt: string, req?: Request): Response {
  if (req && isNavigation(req)) return refusalPage(404, attempt);
  return json(404, { error: 'not_found', attempt }, { 'x-attempt-id': attempt });
}

// A person pasting the link into a tab gets a short page, same status, same
// emptiness: no file, no name, no size.
export function isNavigation(req: Request): boolean {
  if (req.headers.get('sec-fetch-mode') === 'navigate') return true;
  const accept = req.headers.get('accept') ?? '';
  return accept.includes('text/html') && !accept.includes('application/json');
}

export function refusalPage(status: 401 | 404, attempt: string | null = null): Response {
  const why = status === 401
    ? 'This request carried no session the server could match, so it gets nothing back.'
    : 'The session that sent this request may not open this file, so it gets nothing back.';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Nothing comes back from this link</title><link rel="stylesheet" href="../style.css"></head><body class="refusal"><main class="refusal-card"><p class="refusal-code">${status}</p><h1>Nothing comes back from this link here.</h1><p>${why} No file and no file details, not even the name. A link to a file that does not exist gets the same answer.</p>${attempt ? `<p class="refusal-ref">Recorded as attempt ${attempt}.</p>` : ''}<p><a href="../">Back to the test</a></p></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE } });
}

function noSession(req: Request): Response {
  return isNavigation(req) ? refusalPage(401) : json(401, { error: 'no_session' });
}

function pdf(data: Uint8Array, attempt: string): Response {
  return new Response(data as Uint8Array<ArrayBuffer>, {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'inline',
      'cache-control': 'private, no-store',
      'x-attempt-id': attempt,
    },
  });
}

type AuditEntry = {
  actor: Actor | null;
  action: string;
  target?: string | null;
  clientId?: string | null;
  firmId?: string | null;
  result: 'allowed' | 'denied';
  reason?: string | null;
};

function audit(ctx: Ctx, e: AuditEntry): string {
  const id = rid('att', 10);
  ctx.db.run(
    'INSERT INTO audit (id, at, firm_id, user_id, actor_label, session_ref, action, target, client_id, result, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, now(ctx), e.firmId ?? e.actor?.firmId ?? null, e.actor?.userId ?? null, e.actor?.label ?? null,
    e.actor?.sessionRef ?? null, e.action, e.target ?? null, e.clientId ?? null, e.result, e.reason ?? null,
  );
  return id;
}

function operatorLog(ctx: Ctx, e: { actor: Actor | null; documentFirmId?: string | null; action: string; target?: string | null; status: number; reason: string; attempt?: string | null }): void {
  ctx.db.run(
    'INSERT INTO operator_log (at, actor_firm_id, document_firm_id, user_id, action, target, status, reason, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    now(ctx), e.actor?.firmId ?? null, e.documentFirmId ?? null, e.actor?.userId ?? null, e.action, e.target ?? null, e.status, e.reason, e.attempt ?? null,
  );
}

const now = (ctx: Ctx) => (ctx.now ? ctx.now() : new Date().toISOString());

function toActor(row: Row, sessionRef: string | null): Actor {
  return {
    userId: String(row.id),
    firmId: String(row.firm_id),
    role: row.role as Role,
    clientId: row.client_id == null ? null : String(row.client_id),
    label: String(row.label),
    sessionRef,
  };
}

// Which session speaks: a browser may hold several demo sessions (one cookie
// each, like several browser profiles). x-demo-session only picks which of
// the cookies it holds is presented; the server alone maps a cookie to a user.
async function sessionActor(req: Request, db: Db): Promise<Actor | null> {
  const cookies = parseCookies(req.headers.get('cookie'));
  const named = req.headers.get('x-demo-session');
  let token: string | undefined;
  if (named) {
    if (!/^[a-z0-9_]{1,32}$/.test(named)) return null;
    token = cookies[`s_${named}`];
  } else {
    const held = Object.keys(cookies).filter((k) => k.startsWith('s_'));
    if (held.length === 1) token = cookies[held[0]];
  }
  if (!token || token.length > 100) return null;
  const rows = db.all(
    'SELECT u.*, s.ref FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    await sha256hex(token),
  );
  if (rows.length !== 1 || rows[0].role === 'service') return null;
  return toActor(rows[0], String(rows[0].ref));
}

async function serviceActor(req: Request, db: Db): Promise<Actor | null> {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer ([A-Za-z0-9_-]{20,100})$/);
  if (!m) return null;
  const rows = db.all(
    "SELECT u.* FROM service_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.role = 'service'",
    await sha256hex(m[1]),
  );
  return rows.length === 1 ? toActor(rows[0], null) : null;
}

// A service identity sees only the queued tasks assigned to it.
function ownQueuedTask(db: Db, taskId: string, actor: Actor): Row | undefined {
  return db.all("SELECT * FROM hermes_tasks WHERE id = ? AND service_user_id = ? AND status = 'queued'", taskId, actor.userId)[0];
}

function assignedAccountant(db: Db, clientId: string): string | null {
  const row = db.all('SELECT accountant_id FROM assignments WHERE client_id = ?', clientId)[0];
  return row ? String(row.accountant_id) : null;
}

type Readable = { ok: true; doc: Row; attempt: string } | { ok: false; attempt: string };

// Every file read goes through here: list entries, metadata and download.
function authorizeRead(ctx: Ctx, actor: Actor, docId: string, action: string): Readable {
  const doc = ctx.db.all('SELECT * FROM documents WHERE id = ?', docId)[0];
  const decision = doc
    ? mayRead(actor, { firmId: String(doc.firm_id), clientId: String(doc.client_id) }, assignedAccountant(ctx.db, String(doc.client_id)))
    : ({ ok: false, reason: 'no_such_file' } as const);
  if (!decision.ok) {
    // The actor's firm sees one reason for "another firm's file" and "no such
    // file", so its own review view cannot tell whether an id exists.
    // The true reason goes to the operator log.
    const outside = decision.reason === 'other_firm' || decision.reason === 'no_such_file';
    const attempt = audit(ctx, {
      actor, action, target: docId, clientId: outside || !doc ? null : String(doc.client_id),
      result: 'denied', reason: outside ? 'not_found' : decision.reason,
    });
    operatorLog(ctx, { actor, documentFirmId: doc ? String(doc.firm_id) : null, action, target: docId, status: 404, reason: decision.reason, attempt });
    return { ok: false, attempt };
  }
  const clientId = String(doc!.client_id);
  return { ok: true, doc: doc!, attempt: audit(ctx, { actor, action, target: docId, clientId, result: 'allowed' }) };
}

function blob(db: Db, key: unknown): Uint8Array {
  return asBytes(db.all('SELECT data FROM blobs WHERE key = ?', key)[0]?.data);
}

async function readBody(req: Request, limit: number): Promise<any> {
  const text = await req.text();
  if (text.length > limit) throw new HttpError(413, 'too_large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function startSessions(req: Request, ctx: Ctx): Promise<Response> {
  const body = await readBody(req, 2000);
  const keys: unknown = body?.identities;
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 10) return json(400, { error: 'identities_required' });
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', ...NO_STORE });
  const sessions = [];
  for (const key of keys) {
    if (typeof key !== 'string' || !/^[a-z0-9_]{1,32}$/.test(key)) return json(400, { error: 'unknown_identity' });
    const user = ctx.db.all("SELECT * FROM users WHERE demo_key = ? AND role != 'service'", key)[0];
    if (!user) return json(400, { error: 'unknown_identity' });
    const token = randomToken();
    const ref = rid('ses', 6);
    ctx.db.run('INSERT INTO sessions (token_hash, ref, user_id, created_at) VALUES (?, ?, ?, ?)', await sha256hex(token), ref, user.id, now(ctx));
    const actor = toActor(user, ref);
    audit(ctx, { actor, action: 'session_start', result: 'allowed' });
    const path = ctx.base || '/';
    headers.append('set-cookie', `s_${key}=${token}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=86400${ctx.secureCookies ? '; Secure' : ''}`);
    sessions.push({ identity: key, label: actor.label, role: actor.role, ref });
  }
  return new Response(JSON.stringify({ sessions }), { status: 200, headers });
}

async function hermesRoutes(req: Request, ctx: Ctx, path: string): Promise<Response> {
  const actor = await serviceActor(req, ctx.db);
  if (!actor) return json(401, { error: 'no_service_identity' });
  if (req.method === 'GET' && path === '/api/hermes/tasks') {
    const tasks = ctx.db.all("SELECT id FROM hermes_tasks WHERE service_user_id = ? AND status = 'queued' ORDER BY id", actor.userId);
    return json(200, {
      tasks: tasks.map((t) => ({ id: t.id, input: `api/hermes/tasks/${t.id}/input`, result: `api/hermes/tasks/${t.id}/result` })),
    });
  }
  const m = path.match(/^\/api\/hermes\/tasks\/([a-z0-9_]{1,64})\/(input|result)$/);
  if (!m) return json(404, { error: 'no_route' });
  const [, taskId, part] = m;
  const task = ownQueuedTask(ctx.db, taskId, actor);
  const action = part === 'input' ? 'hermes_read' : 'hermes_write';
  if (!task) return refused(audit(ctx, { actor, action, target: taskId, result: 'denied', reason: 'no_such_task' }));

  if (req.method === 'GET' && part === 'input') {
    const doc = ctx.db.all('SELECT * FROM documents WHERE id = ? AND client_id = ? AND firm_id = ?', task.input_document_id, task.client_id, task.firm_id)[0];
    if (!doc) return refused(audit(ctx, { actor, action, target: taskId, result: 'denied', reason: 'no_such_file' }));
    const attempt = audit(ctx, { actor, action, target: String(doc.id), clientId: String(task.client_id), result: 'allowed' });
    return pdf(blob(ctx.db, doc.blob_key), attempt);
  }
  if (req.method === 'POST' && part === 'result') {
    const body = await readBody(req, 1_500_000);
    // Hermes names the client it believes it is writing for. If that is not
    // the task's client, nothing is written.
    if (body?.client_id !== task.client_id) {
      return refused(audit(ctx, { actor, action, target: taskId, clientId: String(task.client_id), result: 'denied', reason: 'client_mismatch' }));
    }
    const name = body?.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9 .,()_-]{1,120}\.pdf$/.test(name)) return json(400, { error: 'bad_name' });
    let data: Uint8Array;
    try {
      data = typeof body?.pdf_base64 === 'string' ? fromBase64(body.pdf_base64) : new Uint8Array();
    } catch {
      return json(400, { error: 'not_a_pdf' });
    }
    if (data.length < 8 || new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-') return json(400, { error: 'not_a_pdf' });
    // Claim the task in one statement before any await: of two concurrent
    // writes, only one finds it still queued.
    const claimed = ctx.db.all(
      "UPDATE hermes_tasks SET status = 'writing' WHERE id = ? AND service_user_id = ? AND status = 'queued' RETURNING id",
      taskId, actor.userId,
    );
    if (claimed.length !== 1) return refused(audit(ctx, { actor, action, target: taskId, result: 'denied', reason: 'no_such_task' }));
    let docId: string;
    try {
      docId = await addDocument(ctx.db, String(task.firm_id), String(task.client_id), name, 'finished', data, now(ctx));
    } catch (e) {
      ctx.db.run("UPDATE hermes_tasks SET status = 'queued' WHERE id = ? AND status = 'writing'", taskId);
      throw e;
    }
    ctx.db.run("UPDATE hermes_tasks SET status = 'done', result_document_id = ? WHERE id = ?", docId, taskId);
    audit(ctx, { actor, action, target: docId, clientId: String(task.client_id), result: 'allowed' });
    return json(201, { document: docId });
  }
  return json(404, { error: 'no_route' });
}

export async function handle(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  let path = url.pathname;
  if (ctx.base && path.startsWith(ctx.base)) path = path.slice(ctx.base.length);
  const method = req.method;
  try {
    if (method === 'POST' && path === '/api/sessions') return await startSessions(req, ctx);
    if (path.startsWith('/api/hermes/')) return await hermesRoutes(req, ctx, path);

    const actor = await sessionActor(req, ctx.db);
    let m: RegExpMatchArray | null;

    if (method === 'GET' && (m = path.match(/^\/files\/([A-Za-z0-9_]{1,64})$/))) {
      if (!actor) {
        operatorLog(ctx, { actor: null, action: 'read', target: m[1], status: 401, reason: 'no_session' });
        return noSession(req);
      }
      const r = authorizeRead(ctx, actor, m[1], 'read');
      if (!r.ok) return refused(r.attempt, req);
      return pdf(blob(ctx.db, r.doc.blob_key), r.attempt);
    }
    if (method === 'GET' && (m = path.match(/^\/api\/files\/([A-Za-z0-9_]{1,64})$/))) {
      if (!actor) {
        operatorLog(ctx, { actor: null, action: 'read_metadata', target: m[1], status: 401, reason: 'no_session' });
        return json(401, { error: 'no_session' });
      }
      const r = authorizeRead(ctx, actor, m[1], 'read_metadata');
      if (!r.ok) return refused(r.attempt);
      const d = r.doc;
      return json(200, { id: d.id, name: d.name, bytes: d.bytes, sha256: d.sha256, kind: d.kind, link: `files/${d.id}` }, { 'x-attempt-id': r.attempt });
    }
    if (!actor) return json(401, { error: 'no_session' });

    if (method === 'GET' && path === '/api/whoami') {
      return json(200, { label: actor.label, role: actor.role, session: actor.sessionRef });
    }
    if (method === 'GET' && path === '/api/files') {
      // Candidates come from the actor's firm; the same rule then decides each one.
      const rows = ctx.db.all('SELECT id, firm_id, client_id, name, bytes, kind FROM documents WHERE firm_id = ? ORDER BY created_at, id', actor.firmId);
      const files = rows
        .filter((d) => mayRead(actor, { firmId: String(d.firm_id), clientId: String(d.client_id) }, assignedAccountant(ctx.db, String(d.client_id))).ok)
        .map((d) => ({ id: d.id, name: d.name, bytes: d.bytes, kind: d.kind, link: `files/${d.id}` }));
      return json(200, { files });
    }
    if (method === 'GET' && path === '/api/clients') {
      if (!mayAdminister(actor, actor.firmId)) return json(403, { error: 'forbidden' });
      const clients = ctx.db.all(
        'SELECT c.id, c.label, u.id AS accountant_id, u.label AS accountant FROM clients c LEFT JOIN assignments a ON a.client_id = c.id LEFT JOIN users u ON u.id = a.accountant_id WHERE c.firm_id = ? ORDER BY c.label',
        actor.firmId,
      );
      const accountants = ctx.db.all("SELECT id, label FROM users WHERE firm_id = ? AND role = 'accountant' ORDER BY label", actor.firmId);
      return json(200, { clients, accountants });
    }
    if (method === 'POST' && path === '/api/assignments') {
      const body = await readBody(req, 2000);
      const client = ctx.db.all('SELECT * FROM clients WHERE id = ?', body?.client_id)[0];
      if (!client || !mayAdminister(actor, String(client.firm_id))) {
        const reason = actor.role !== 'firm_admin' ? 'role_not_allowed' : 'no_such_client';
        return json(403, { error: 'forbidden', attempt: audit(ctx, { actor, action: 'reassign', target: String(body?.client_id ?? ''), result: 'denied', reason }) });
      }
      const next = ctx.db.all("SELECT * FROM users WHERE id = ? AND role = 'accountant' AND firm_id = ?", body?.accountant_id, client.firm_id)[0];
      if (!next) return json(400, { error: 'unknown_accountant' });
      const prev = ctx.db.all('SELECT u.id, u.label FROM assignments a JOIN users u ON u.id = a.accountant_id WHERE a.client_id = ?', client.id)[0];
      if (prev && prev.id === next.id) return json(200, { client: client.label, accountant: next.label, unchanged: true });
      ctx.db.run(
        'INSERT INTO assignments (client_id, accountant_id, assigned_at) VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET accountant_id = excluded.accountant_id, assigned_at = excluded.assigned_at',
        client.id, next.id, now(ctx),
      );
      const attempt = audit(ctx, {
        actor, action: 'reassign', target: String(client.id), clientId: String(client.id), result: 'allowed',
        reason: `${prev ? String(prev.label) : 'nobody'} to ${String(next.label)}`,
      });
      return json(200, { client: client.label, accountant: next.label, attempt });
    }
    if (method === 'GET' && path === '/api/audit') {
      if (!mayAdminister(actor, actor.firmId)) return json(403, { error: 'forbidden' });
      const entries = ctx.db.all(
        "SELECT id, at, actor_label AS actor, session_ref AS session, action, target, result, reason FROM audit WHERE firm_id = ? AND action != 'session_start' ORDER BY seq DESC LIMIT 100",
        actor.firmId,
      );
      return json(200, { entries });
    }
    return json(404, { error: 'no_route' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    return json(500, { error: 'server_error' });
  }
}
