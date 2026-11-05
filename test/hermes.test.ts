// Hermes is driven here by a scripted HTTP client: same routes a real agent
// would call, deterministic, no model behind it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makePdf } from '../src/pdf.ts';
import { toBase64Url } from '../src/util.ts';
import { setup } from './helpers.ts';

const finishedPdf = () => {
  const b64url = toBase64Url(makePdf(['Finished work (fictional)', 'Returned by the service identity.']));
  return b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
};

test('Hermes reads the upload assigned to its task', async () => {
  const { seed, hermes } = await setup();
  const { tasks } = await (await hermes.request('GET', '/api/hermes/tasks')).json();
  assert.deepEqual(tasks.map((t: { id: string }) => t.id), [seed.tasks.a]);
  const res = await hermes.request('GET', `/${tasks[0].input}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
});

test("Hermes writes its result into the same client's folder, visible to that client only", async () => {
  const { seed, hermes, as } = await setup();
  const res = await hermes.request('POST', `/api/hermes/tasks/${seed.tasks.a}/result`, {
    client_id: seed.clients.a,
    name: 'Finished organizer, Client A (fictional).pdf',
    pdf_base64: finishedPdf(),
  });
  assert.equal(res.status, 201);
  const { document } = await res.json();
  const clientA = await as('client_a');
  assert.equal((await clientA.get(`/files/${document}`)).status, 200);
  const clientB = await as('client_b');
  assert.equal((await clientB.get(`/files/${document}`)).status, 404);
});

test('Hermes fails when the client id in its write is swapped for another client', async () => {
  const { db, seed, hermes } = await setup();
  const before = db.all('SELECT COUNT(*) AS n FROM documents')[0].n;
  const res = await hermes.request('POST', `/api/hermes/tasks/${seed.tasks.a}/result`, {
    client_id: seed.clients.b,
    name: 'Finished organizer (fictional).pdf',
    pdf_base64: finishedPdf(),
  });
  assert.equal(res.status, 404);
  assert.equal(db.all('SELECT COUNT(*) AS n FROM documents')[0].n, before, 'nothing written');
  const row = db.all("SELECT reason FROM audit WHERE action = 'hermes_write' ORDER BY seq DESC LIMIT 1")[0];
  assert.equal(row.reason, 'client_mismatch');
});

test("Hermes's token opens nothing outside its task", async () => {
  const { seed, hermes } = await setup();
  assert.equal((await hermes.request('GET', `/files/${seed.docs.b}`)).status, 401);
  assert.equal((await hermes.request('GET', '/api/files')).status, 401);
  assert.equal((await hermes.request('GET', '/api/hermes/tasks/task_doesnotexist0/input')).status, 404);
  await hermes.request('POST', `/api/hermes/tasks/${seed.tasks.a}/result`, {
    client_id: seed.clients.a, name: 'Done (fictional).pdf', pdf_base64: finishedPdf(),
  });
  assert.equal((await hermes.request('GET', `/api/hermes/tasks/${seed.tasks.a}/input`)).status, 404, 'a finished task is closed');
});

test("one Hermes identity cannot read or complete another identity's task", async () => {
  const { db, seed, hermes, hermes2 } = await setup();
  const mine = await (await hermes.request('GET', '/api/hermes/tasks')).json();
  assert.ok(!mine.tasks.some((t: { id: string }) => t.id === seed.tasks.b), 'task 2 is not listed for identity 1');
  assert.equal((await hermes.request('GET', `/api/hermes/tasks/${seed.tasks.b}/input`)).status, 404, 'identity 1 reads task 2');
  const write = await hermes.request('POST', `/api/hermes/tasks/${seed.tasks.b}/result`, {
    client_id: seed.clients.b, name: 'Finished (fictional).pdf', pdf_base64: finishedPdf(),
  });
  assert.equal(write.status, 404, 'identity 1 completes task 2');
  assert.equal(db.all('SELECT status FROM hermes_tasks WHERE id = ?', seed.tasks.b)[0].status, 'queued');
  // The rightful identity still can.
  assert.equal((await hermes2.request('GET', `/api/hermes/tasks/${seed.tasks.b}/input`)).status, 200);
});

test('two simultaneous result writes for one task: exactly one is accepted', async () => {
  const { db, seed, hermes } = await setup();
  const body = { client_id: seed.clients.a, name: 'Finished organizer (fictional).pdf', pdf_base64: finishedPdf() };
  const before = Number(db.all("SELECT COUNT(*) AS n FROM documents WHERE kind = 'finished'")[0].n);
  const results = await Promise.all([
    hermes.request('POST', `/api/hermes/tasks/${seed.tasks.a}/result`, body),
    hermes.request('POST', `/api/hermes/tasks/${seed.tasks.a}/result`, body),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 404]);
  const after = Number(db.all("SELECT COUNT(*) AS n FROM documents WHERE kind = 'finished'")[0].n);
  assert.equal(after - before, 1);
});
