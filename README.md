# portal-isolation-check

A small, runnable answer to one question an accounting firm's client portal has to settle before launch: **who can open this file?**

Fictional firm, fictional clients, fictional PDFs. No sign-in provider, no cloud account, no model API: the point is the access rule and the tests that hold it in place.

## What it proves

| Rule | Test (in `test/`) |
| --- | --- |
| A client opens their own file by its link | `client A opens their own file by its link` |
| The same link, sent from another client's own server session, returns no file and no file details, only the id of an audit row | `client B cannot open client A's file by its link` |
| A refused file and a missing file get the same answer | `a refused link looks exactly like a link to a file that does not exist` |
| Lists and metadata go through the same rule as downloads | `client B's file list and metadata route do not reveal client A's file` |
| The link pasted into a tab with no matching session gets a short page with the same status, and nothing else | `the link pasted into a browser tab with no matching session gets a short page and nothing else` |
| An accountant opens only assigned clients; a reassignment applies to sessions already open | `after a reassignment, the previous accountant's open session is refused and the new accountant is allowed` |
| Client B's denied read is recorded with its attempt id, readable only by a firm admin; the audit table rejects UPDATE and DELETE in this test | `audit.test.ts` |
| Reads with no valid session get 401 and leave no row in a firm's review view; they go to an operator log that no route serves | `reads with no valid session get 401, ...` |
| Another firm sees one reason for "file of another firm" and "no such file"; the operator log keeps the difference | `another firm's review view shows one reason ...` |
| A document agent (Hermes) can process only tasks assigned to its service identity: it reads the assigned upload, writes the result to the same client, fails if the client id is swapped, cannot touch another identity's task, and two simultaneous writes produce one result | `hermes.test.ts` (driven by a scripted HTTP client) |

All human file reads share one access rule, `mayRead()` in `src/policy.ts`: every route that can return a file, its name or its metadata calls it, with the assignment read fresh from the database on each request. Service routes have their own task-scoped check in `src/portal.ts`.

## Run it

```sh
npm ci
npm test          # 24 tests
npm run mutant    # same tests on copies of the code with one control removed: each must fail on its expected test
```

Node 24 or later (built-in `node:sqlite` and TypeScript type stripping; no other runtime dependency).

`npm run mutant` copies `src/` and `test/` to a temporary folder, removes one control (listed in `mutants/mutants.json`: the client check in the access rule, then the task-owner filter of the service identity), runs the suite and passes only if the expected test goes red each time. The working tree is never modified and no red branch is needed.

CI (`.github/workflows/ci.yml`) runs three jobs on every push: the tests, the mutant run, and a secrets scan (gitleaks on the full history, plus a planted key that the scanner must refuse).

## Routes

`src/portal.ts` takes a Web-standard `Request` and returns a `Response`, so it can sit behind a Next.js route handler as well as the Worker in `worker/`.

| Route | Who |
| --- | --- |
| `POST /api/sessions` | starts a server session for a demo identity (one cookie per identity) |
| `GET /api/files`, `GET /api/files/:id`, `GET /files/:id` | list, metadata, download; each one re-authorized on the server |
| `GET /api/clients`, `POST /api/assignments` | firm admin: reassign a client to another accountant |
| `GET /api/audit` | firm admin: the review view |
| `GET /api/hermes/tasks`, `GET /api/hermes/tasks/:id/input`, `POST /api/hermes/tasks/:id/result` | service identity, bearer token, its own tasks only |

A browser may hold several demo sessions at once, one cookie each, like several browser profiles. The `x-demo-session` header only picks which of the cookies it holds is presented; the server alone maps a cookie to a user.

## Hosting of the public demo

Cloudflare Workers, one Durable Object per visitor with its own SQLite database, seeded with fictional records and scheduled for deletion after 24 hours. `npm run dev` runs the same Worker locally on 127.0.0.1.

## Not in this prototype, on purpose

- Sign-in and multi-factor authentication. They belong to the identity provider and get their own test on staging (every role, staff included, refused without a second factor).
- Azure Blob Storage and PostgreSQL. In production the same rule would sit in the data layer, with row-level security as a second lock tested under the application's own database role (not the table owner, no `BYPASSRLS`). Every new download request, including large-file range requests, would check the current assignment before serving bytes.
- Monitoring, alerting and retention of the production audit log.
- Real integrations. Nothing here connects to any accounting, CRM or agent system.

Prepared by Frederic de Lavenne de Choulot, The AI Pipe.
