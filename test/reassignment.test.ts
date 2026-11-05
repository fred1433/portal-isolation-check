import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setup } from './helpers.ts';

test('an accountant opens only the clients assigned to them', async () => {
  const { seed, as } = await setup();
  const acct1 = await as('accountant_1');
  assert.equal((await acct1.get(`/files/${seed.docs.a}`)).status, 200);
  assert.equal((await acct1.get(`/files/${seed.docs.b}`)).status, 404);
  const acct2 = await as('accountant_2');
  assert.equal((await acct2.get(`/files/${seed.docs.a}`)).status, 404);
  assert.equal((await acct2.get(`/files/${seed.docs.b}`)).status, 200);
});

test("after a reassignment, the previous accountant's open session is refused and the new accountant is allowed", async () => {
  const { seed, as } = await setup();
  const acct1 = await as('accountant_1'); // signed in before the change, and stays signed in
  const acct2 = await as('accountant_2');
  assert.equal((await acct1.get(`/files/${seed.docs.a}`)).status, 200);

  const admin = await as('firm_admin');
  const res = await admin.post('/api/assignments', { client_id: seed.clients.a, accountant_id: seed.users.accountant_2 });
  assert.equal(res.status, 200);

  assert.equal((await acct1.get(`/files/${seed.docs.a}`)).status, 404);
  assert.equal((await acct2.get(`/files/${seed.docs.a}`)).status, 200);
  const list = await (await acct1.get('/api/files')).json();
  assert.ok(!list.files.some((f: { id: string }) => f.id === seed.docs.a));

  const { entries } = await (await admin.get('/api/audit')).json();
  const change = entries.find((e: { action: string }) => e.action === 'reassign');
  assert.equal(change.reason, 'Accountant 1 to Accountant 2');
});

test('only a firm admin can reassign a client', async () => {
  const { seed, as } = await setup();
  for (const identity of ['accountant_2', 'client_a', 'f2_admin']) {
    const b = await as(identity);
    const res = await b.post('/api/assignments', { client_id: seed.clients.a, accountant_id: seed.users.accountant_2 });
    assert.equal(res.status, 403, identity);
  }
  const acct1 = await as('accountant_1');
  assert.equal((await acct1.get(`/files/${seed.docs.a}`)).status, 200, 'assignment unchanged');
});

test('a reassignment that changes nothing writes no audit row; an unknown client is named as such', async () => {
  const { db, seed, as } = await setup();
  const admin = await as('firm_admin');
  const before = Number(db.all("SELECT COUNT(*) AS n FROM audit WHERE action = 'reassign'")[0].n);
  const same = await admin.post('/api/assignments', { client_id: seed.clients.a, accountant_id: seed.users.accountant_1 });
  assert.equal(same.status, 200);
  assert.equal((await same.json()).unchanged, true);
  assert.equal(Number(db.all("SELECT COUNT(*) AS n FROM audit WHERE action = 'reassign'")[0].n), before);
  const unknown = await admin.post('/api/assignments', { client_id: 'cli_doesnotexist', accountant_id: seed.users.accountant_2 });
  assert.equal(unknown.status, 403);
  const row = db.all("SELECT reason FROM audit WHERE action = 'reassign' ORDER BY seq DESC LIMIT 1")[0];
  assert.equal(row.reason, 'no_such_client');
});
