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
