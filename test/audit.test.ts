import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.ts';

test('every refused read writes one audit row, found by its attempt id in the review view', async () => {
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

test('the audit table refuses updates and deletes', async () => {
  const { db, seed, as } = await setup();
  const clientB = await as('client_b');
  await clientB.get(`/files/${seed.docs.a}`);
  assert.throws(() => db.run("UPDATE audit SET result = 'allowed'"), /append-only/);
  assert.throws(() => db.run('DELETE FROM audit'), /append-only/);
});
