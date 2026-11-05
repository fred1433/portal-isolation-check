// The one access rule. Every route that can return a file, its name or its
// metadata calls mayRead(); nothing else decides. The assignment is passed in
// fresh from the database on every request, never cached in the session, so a
// reassignment takes effect on sessions that are already open.

export type Role = 'client' | 'accountant' | 'firm_admin' | 'service';

export type Actor = {
  userId: string;
  firmId: string;
  role: Role;
  clientId: string | null;
  label: string;
  sessionRef: string | null;
};

export type DocRef = { firmId: string; clientId: string };

export type Denial = 'other_firm' | 'other_client' | 'not_assigned' | 'role_not_allowed';
export type Decision = { ok: true } | { ok: false; reason: Denial };

export function mayRead(actor: Actor, doc: DocRef, assignedAccountantId: string | null): Decision {
  if (actor.firmId !== doc.firmId) return { ok: false, reason: 'other_firm' };
  if (actor.role === 'firm_admin') return { ok: true };
  if (actor.role === 'accountant') {
    if (assignedAccountantId !== actor.userId) return { ok: false, reason: 'not_assigned' };
    return { ok: true };
  }
  if (actor.role === 'client') {
    if (actor.clientId !== doc.clientId) return { ok: false, reason: 'other_client' };
    return { ok: true };
  }
  // Service identities (Hermes) never read through the user routes; they have
  // their own task-scoped routes in portal.ts.
  return { ok: false, reason: 'role_not_allowed' };
}

export function mayAdminister(actor: Actor, firmId: string): boolean {
  return actor.role === 'firm_admin' && actor.firmId === firmId;
}
