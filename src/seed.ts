// Fictional records only. Two firms so the firm boundary is tested too; the
// demo page shows firm 1.
import type { Db } from './db.ts';
import { makePdf } from './pdf.ts';
import { randomToken, rid, sha256hex } from './util.ts';

export type Seed = {
  firm1: string;
  firm2: string;
  clients: { a: string; b: string; c: string; f2: string };
  users: Record<string, string>;
  docs: { a: string; b: string; c: string; f2: string };
  tasks: { a: string };
  hermesToken: string;
};

const LINES: Record<string, string[]> = {
  a: [
    'Client A: 2025 source documents',
    'FICTIONAL RECORD. No real taxpayer. Built for a client-isolation prototype.',
    '',
    'W-2, employer 1 ............................ 48,210.00',
    '1099-INT, savings account ...................... 312.44',
    'Property tax statement ...................... 2,906.18',
    'Childcare receipts ............................. 4,150.00',
    '',
    'Only Client A, the accountant assigned to Client A and a firm admin',
    'may open this file.',
  ],
  b: [
    'Client B: 2025 payroll summary',
    'FICTIONAL RECORD. No real taxpayer. Built for a client-isolation prototype.',
    '',
    'Gross wages, 4 employees .................. 161,480.00',
    'Federal withholding ......................... 18,902.11',
  ],
  c: [
    'Client C: 2025 bank statements',
    'FICTIONAL RECORD. No real taxpayer. Built for a client-isolation prototype.',
  ],
  f2: [
    'Firm 2 client: 2025 engagement letter',
    'FICTIONAL RECORD. Belongs to a second, unrelated firm.',
  ],
};

async function addDocument(db: Db, firmId: string, clientId: string, name: string, kind: string, data: Uint8Array, at: string): Promise<string> {
  const id = rid('doc', 16);
  const blobKey = rid('blob', 20);
  db.run('INSERT INTO blobs (key, data) VALUES (?, ?)', blobKey, data);
  db.run(
    'INSERT INTO documents (id, firm_id, client_id, name, kind, blob_key, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, firmId, clientId, name, kind, blobKey, data.length, await sha256hex(data), at,
  );
  return id;
}

export { addDocument };

export async function seedDemo(db: Db, at: string): Promise<Seed> {
  const firm1 = rid('firm');
  const firm2 = rid('firm');
  db.run('INSERT INTO firms (id, label) VALUES (?, ?)', firm1, 'Firm 1 (fictional)');
  db.run('INSERT INTO firms (id, label) VALUES (?, ?)', firm2, 'Firm 2 (fictional)');

  const clients = { a: rid('cli'), b: rid('cli'), c: rid('cli'), f2: rid('cli') };
  db.run('INSERT INTO clients (id, firm_id, label) VALUES (?, ?, ?)', clients.a, firm1, 'Client A');
  db.run('INSERT INTO clients (id, firm_id, label) VALUES (?, ?, ?)', clients.b, firm1, 'Client B');
  db.run('INSERT INTO clients (id, firm_id, label) VALUES (?, ?, ?)', clients.c, firm1, 'Client C');
  db.run('INSERT INTO clients (id, firm_id, label) VALUES (?, ?, ?)', clients.f2, firm2, 'Firm 2 client');

  const users: Record<string, string> = {};
  const addUser = (key: string | null, firm: string, role: string, clientId: string | null, label: string) => {
    const id = rid('usr');
    db.run('INSERT INTO users (id, firm_id, role, client_id, label, demo_key) VALUES (?, ?, ?, ?, ?, ?)', id, firm, role, clientId, label, key);
    users[key ?? label] = id;
    return id;
  };
  addUser('client_a', firm1, 'client', clients.a, 'Client A');
  addUser('client_b', firm1, 'client', clients.b, 'Client B');
  addUser('client_c', firm1, 'client', clients.c, 'Client C');
  const acct1 = addUser('accountant_1', firm1, 'accountant', null, 'Accountant 1');
  const acct2 = addUser('accountant_2', firm1, 'accountant', null, 'Accountant 2');
  addUser('firm_admin', firm1, 'firm_admin', null, 'Firm admin');
  addUser('f2_admin', firm2, 'firm_admin', null, 'Firm 2 admin');
  addUser('f2_client', firm2, 'client', clients.f2, 'Firm 2 client');
  const hermes = addUser(null, firm1, 'service', null, 'Hermes (service)');

  db.run('INSERT INTO assignments (client_id, accountant_id, assigned_at) VALUES (?, ?, ?)', clients.a, acct1, at);
  db.run('INSERT INTO assignments (client_id, accountant_id, assigned_at) VALUES (?, ?, ?)', clients.b, acct2, at);
  db.run('INSERT INTO assignments (client_id, accountant_id, assigned_at) VALUES (?, ?, ?)', clients.c, acct2, at);

  const docs = {
    a: await addDocument(db, firm1, clients.a, '2025 source documents, Client A (fictional).pdf', 'client_upload', makePdf(LINES.a), at),
    b: await addDocument(db, firm1, clients.b, '2025 payroll summary, Client B (fictional).pdf', 'client_upload', makePdf(LINES.b), at),
    c: await addDocument(db, firm1, clients.c, '2025 bank statements, Client C (fictional).pdf', 'client_upload', makePdf(LINES.c), at),
    f2: await addDocument(db, firm2, clients.f2, '2025 engagement letter, Firm 2 client (fictional).pdf', 'client_upload', makePdf(LINES.f2), at),
  };

  const hermesToken = randomToken();
  db.run('INSERT INTO service_tokens (token_hash, user_id) VALUES (?, ?)', await sha256hex(hermesToken), hermes);
  const taskA = rid('task');
  db.run(
    "INSERT INTO hermes_tasks (id, firm_id, client_id, input_document_id, service_user_id, status) VALUES (?, ?, ?, ?, ?, 'queued')",
    taskA, firm1, clients.a, docs.a, hermes,
  );

  return { firm1, firm2, clients, users, docs, tasks: { a: taskA }, hermesToken };
}
