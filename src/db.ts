// The storage seam. Two adapters implement it: node:sqlite in the tests,
// Durable Object SQLite in the deployed Worker. Same SQL in both.
export type Row = Record<string, unknown>;

export interface Db {
  all(sql: string, ...params: unknown[]): Row[];
  run(sql: string, ...params: unknown[]): void;
}

export const SCHEMA: string[] = [
  `CREATE TABLE firms (
     id TEXT PRIMARY KEY,
     label TEXT NOT NULL)`,
  `CREATE TABLE clients (
     id TEXT PRIMARY KEY,
     firm_id TEXT NOT NULL REFERENCES firms(id),
     label TEXT NOT NULL)`,
  `CREATE TABLE users (
     id TEXT PRIMARY KEY,
     firm_id TEXT NOT NULL REFERENCES firms(id),
     role TEXT NOT NULL CHECK (role IN ('client','accountant','firm_admin','service')),
     client_id TEXT REFERENCES clients(id),
     label TEXT NOT NULL,
     demo_key TEXT UNIQUE,
     CHECK ((role = 'client') = (client_id IS NOT NULL)))`,
  `CREATE TABLE assignments (
     client_id TEXT PRIMARY KEY REFERENCES clients(id),
     accountant_id TEXT NOT NULL REFERENCES users(id),
     assigned_at TEXT NOT NULL)`,
  `CREATE TABLE documents (
     id TEXT PRIMARY KEY,
     firm_id TEXT NOT NULL REFERENCES firms(id),
     client_id TEXT NOT NULL REFERENCES clients(id),
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('client_upload','finished')),
     blob_key TEXT NOT NULL UNIQUE,
     bytes INTEGER NOT NULL,
     sha256 TEXT NOT NULL,
     created_at TEXT NOT NULL)`,
  // Private object storage stand-in: no route ever serves a blob by its key.
  `CREATE TABLE blobs (
     key TEXT PRIMARY KEY,
     data BLOB NOT NULL)`,
  `CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     ref TEXT NOT NULL UNIQUE,
     user_id TEXT NOT NULL REFERENCES users(id),
     created_at TEXT NOT NULL)`,
  `CREATE TABLE service_tokens (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id))`,
  `CREATE TABLE hermes_tasks (
     id TEXT PRIMARY KEY,
     firm_id TEXT NOT NULL REFERENCES firms(id),
     client_id TEXT NOT NULL REFERENCES clients(id),
     input_document_id TEXT NOT NULL REFERENCES documents(id),
     service_user_id TEXT NOT NULL REFERENCES users(id),
     status TEXT NOT NULL CHECK (status IN ('queued','writing','done')),
     result_document_id TEXT REFERENCES documents(id))`,
  `CREATE TABLE audit (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     at TEXT NOT NULL,
     firm_id TEXT,
     user_id TEXT,
     actor_label TEXT,
     session_ref TEXT,
     action TEXT NOT NULL,
     target TEXT,
     client_id TEXT,
     result TEXT NOT NULL CHECK (result IN ('allowed','denied')),
     reason TEXT)`,
  // Operator log: every refusal with its true reason, including reads with no
  // valid session and attempts from another firm. No route serves it.
  `CREATE TABLE operator_log (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     actor_firm_id TEXT,
     document_firm_id TEXT,
     user_id TEXT,
     action TEXT NOT NULL,
     target TEXT,
     status INTEGER NOT NULL,
     reason TEXT NOT NULL,
     attempt TEXT)`,
  `CREATE TRIGGER operator_log_no_update BEFORE UPDATE ON operator_log
     BEGIN SELECT RAISE(ABORT, 'operator log is append-only'); END`,
  `CREATE TRIGGER operator_log_no_delete BEFORE DELETE ON operator_log
     BEGIN SELECT RAISE(ABORT, 'operator log is append-only'); END`,
  `CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
     BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END`,
  `CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
     BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END`,
];

export function applySchema(db: Db): void {
  for (const statement of SCHEMA) db.run(statement);
}

export function hasSchema(db: Db): boolean {
  return db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'firms'`).length === 1;
}
