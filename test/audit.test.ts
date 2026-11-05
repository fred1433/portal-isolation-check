import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.ts';

test("Client B's denied read is recorded with its attempt id, found in the review view", async () => {
  const { db, seed, as } = await setup();
  const clientB = await as('client_b');
  const before = db.all("SELECT COUNT(*) AS n FROM audit WHERE result = 'denied'")[0].n;
  const { attempt } = await (await clientB.get(`/files/${seed.docs.a}`)).json();
  const after = db.all("SELECT COUNT(*) AS n FROM audit WHERE result = 'denied'")[0].n;
  assert.equal(Number(after) - Number(before), 1);

  const admin = await as('firm_admin');
  const { entries } = await (await admin.get('/api/audit')).json();
  const row = entries.find((e: { id: string }) => e.id === attempt);
  assert.ok(row, 'the refused attempt is in the review view');
  assert.equal(row.actor, 'Client B');
  assert.equal(row.action, 'read');
  assert.equal(row.target, seed.docs.a);
  assert.equal(row.result, 'denied');
  assert.equal(row.reason, 'other_client');
});

test('clients and accountants cannot open the review view', async () => {
  const { as } = await setup();
  for (const identity of ['client_a', 'client_b', 'accountant_1']) {
    const b = await as(identity);
    assert.equal((await b.get('/api/audit')).status, 403, identity);
  }
});

test('the audit table rejects UPDATE and DELETE', async () => {
  const { db, seed, as } = await setup();
  const clientB = await as('client_b');
  await clientB.get(`/files/${seed.docs.a}`);
  assert.throws(() => db.run("UPDATE audit SET result = 'allowed'"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit'), /append-only/);
});

test('reads with no valid session get 401, no row in any firm review view, one row in the operator log', async () => {
  const { db, seed, app } = await setup();
  const audit0 = Number(db.all('SELECT COUNT(*) AS n FROM audit')[0].n);
  for (let i = 0; i < 3; i++) {
    const res = await app(new Request(`http://portal.test/files/${seed.docs.a}`, { headers: { cookie: 's_client_a=forgedtokenforgedtoken' } }));
    assert.equal(res.status, 401);
  }
  assert.equal(Number(db.all('SELECT COUNT(*) AS n FROM audit')[0].n), audit0);
  const ops = db.all("SELECT reason, status FROM operator_log WHERE reason = 'no_session'");
  assert.equal(ops.length, 3);
});

test("another firm's review view shows one reason for an existing file and a missing one; the operator log keeps the difference", async () => {
  const { db, seed, as } = await setup();
  const outsider = await as('f2_admin');
  const real = await (await outsider.get(`/files/${seed.docs.a}`)).json();
  const fake = await (await outsider.get('/files/doc_doesnotexist0000')).json();
  const { entries } = await (await outsider.get('/api/audit')).json();
  const a = entries.find((e: { id: string }) => e.id === real.attempt);
  const b = entries.find((e: { id: string }) => e.id === fake.attempt);
  assert.equal(a.reason, 'not_found');
  assert.equal(b.reason, 'not_found');
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
  const ops = db.all('SELECT attempt, reason, document_firm_id FROM operator_log WHERE attempt IN (?, ?)', real.attempt, fake.attempt);
  assert.deepEqual(ops.map((o) => o.reason).sort(), ['no_such_file', 'other_firm']);
});

test('the operator log rejects UPDATE and DELETE', async () => {
  const { db, seed, as } = await setup();
  const clientB = await as('client_b');
  await clientB.get(`/files/${seed.docs.a}`);
  assert.throws(() => db.run("UPDATE operator_log SET reason = 'x'"), /append-only/);
  assert.throws(() => db.run('DELETE FROM operator_log'), /append-only/);
});
