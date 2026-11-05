import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sha256hex } from '../src/util.ts';
import { bytesOf, setup } from './helpers.ts';

test('client A opens their own file by its link', async () => {
  const { db, seed, as } = await setup();
  const clientA = await as('client_a');
  const res = await clientA.get(`/files/${seed.docs.a}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const data = await bytesOf(res);
  const stored = db.all('SELECT sha256 FROM documents WHERE id = ?', seed.docs.a)[0].sha256;
  assert.equal(await sha256hex(data), stored);
});

test("client B cannot open client A's file by its link", async () => {
  const { seed, as } = await setup();
  const clientA = await as('client_a');
  const list = await (await clientA.get('/api/files')).json();
  const link = `/${list.files[0].link}`; // the link exactly as client A got it
  const clientB = await as('client_b');
  const res = await clientB.get(link);
  assert.equal(res.status, 404);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['attempt', 'error']);
  assert.equal(body.error, 'not_found');
  assert.match(body.attempt, /^att_/);
  assert.ok(!text.includes('Client A'), 'no file name or client name in the refusal');
  assert.equal(res.headers.get('content-disposition'), null);
  assert.ok(seed.docs.a, 'the file exists');
});

test('a refused link looks exactly like a link to a file that does not exist', async () => {
  const { seed, as } = await setup();
  const clientB = await as('client_b');
  const refusedRes = await clientB.get(`/files/${seed.docs.a}`);
  const missingRes = await clientB.get('/files/doc_doesnotexist0000');
  assert.equal(refusedRes.status, missingRes.status);
  assert.equal(refusedRes.headers.get('content-type'), missingRes.headers.get('content-type'));
  const a = await refusedRes.json();
  const b = await missingRes.json();
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  assert.equal(a.error, b.error);
});

test("client B's file list and metadata route do not reveal client A's file", async () => {
  const { seed, as } = await setup();
  const clientB = await as('client_b');
  const list = await (await clientB.get('/api/files')).json();
  assert.deepEqual(list.files.map((f: { id: string }) => f.id), [seed.docs.b]);
  const meta = await clientB.get(`/api/files/${seed.docs.a}`);
  assert.equal(meta.status, 404);
  assert.ok(!(await meta.text()).includes('Client A'));
});

test('the two clients hold two distinct server sessions', async () => {
  const { as } = await setup();
  const clientA = await as('client_a');
  const clientB = await as('client_b');
  const a = await (await clientA.get('/api/whoami')).json();
  const b = await (await clientB.get('/api/whoami')).json();
  assert.equal(a.label, 'Client A');
  assert.equal(b.label, 'Client B');
  assert.notEqual(a.session, b.session);
});

test("naming another identity without holding its session cookie gets no session", async () => {
  const { seed, as } = await setup();
  const clientB = await as('client_b');
  const res = await clientB.get(`/files/${seed.docs.a}`, { 'x-demo-session': 'client_a' });
  assert.equal(res.status, 401);
  const forged = await clientB.get(`/files/${seed.docs.a}`, { cookie: 's_client_a=forged-token-value' });
  assert.notEqual(forged.status, 200);
});

test('nobody from another firm opens the file, not even its admin', async () => {
  const { seed, as } = await setup();
  for (const identity of ['f2_admin', 'f2_client']) {
    const outsider = await as(identity);
    const res = await outsider.get(`/files/${seed.docs.a}`);
    assert.equal(res.status, 404, identity);
    const list = await (await outsider.get('/api/files')).json();
    assert.ok(!list.files.some((f: { id: string }) => f.id === seed.docs.a), identity);
  }
});

test('the link pasted into a browser tab with no matching session gets a short page and nothing else', async () => {
  const { seed, app, as } = await setup();
  const nav = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };
  const fresh = await app(new Request(`http://portal.test/files/${seed.docs.a}`, { headers: nav }));
  assert.equal(fresh.status, 401);
  assert.match(fresh.headers.get('content-type') ?? '', /text\/html/);
  const page = await fresh.text();
  assert.match(page, /Nothing comes back from this link/);
  assert.ok(!page.includes('Client A') && !page.includes('.pdf'), 'no name in the page');
  const clientB = await as('client_b');
  const refusedNav = await clientB.get(`/files/${seed.docs.a}`, nav);
  assert.equal(refusedNav.status, 404);
  const text = await refusedNav.text();
  assert.match(text, /Recorded as attempt att_/);
  assert.ok(!text.includes('Client A'));
});
