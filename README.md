# portal-isolation-check

A small, runnable answer to one question an accounting firm's client portal has to settle before launch: **who can open this file?**

Fictional firm, fictional clients, fictional PDFs. No sign-in provider, no cloud account, no model API: the point is the access rule and the tests that hold it in place.

## What it proves

| Rule | Test (in `test/`) |
| --- | --- |
| A client opens their own file by its link | `client A opens their own file by its link` |
| The same link, sent from another client's own server session, returns nothing: no content, no name, no preview, only the id of an audit row | `client B cannot open client A's file by its link` |
| A refused file and a missing file get the same answer | `a refused link looks exactly like a link to a file that does not exist` |
| Lists and metadata go through the same rule as downloads | `client B's file list and metadata route do not reveal client A's file` |
| An accountant opens only assigned clients; a reassignment applies to sessions already open | `after a reassignment, the previous accountant's open session is refused and the new accountant is allowed` |
| Every refused read leaves one append-only audit row, readable only by a firm admin | `audit.test.ts` |
| The firm boundary holds (a second fictional firm, its admin included) | `nobody from another firm opens the file, not even its admin` |
| The document agent works through a task-scoped service identity: it reads the assigned upload, writes the result to the same client, and fails if the client id is swapped | `hermes.test.ts` (driven by a scripted HTTP client) |

The rule lives in one function, `mayRead()` in `src/policy.ts`. Every route that can return a file, its name or its metadata calls it, with the assignment read fresh from the database on each request.

## Run it

```sh
npm ci
npm test          # 17 tests
npm run mutant    # same tests on a copy of the code without the client check: must fail on the expected test
```

Node 24 or later (built-in `node:sqlite` and TypeScript type stripping; no other runtime dependency).

`npm run mutant` copies `src/` and `test/` to a temporary folder, removes one line from the rule (listed in `mutants/mutants.json`), runs the suite and passes only if `client B cannot open client A's file by its link` goes red. The working tree is never modified and no red branch is needed.

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

Cloudflare Workers, one Durable Object per visitor with its own SQLite database, seeded with fictional records and erased after 24 hours. `npm run dev` runs the same Worker locally on 127.0.0.1.

## Not in this prototype, on purpose

- Sign-in and multi-factor authentication. They belong to the identity provider and get their own test on staging (every role, staff included, refused without a second factor).
- Azure Blob Storage and PostgreSQL. In production the same rule would sit in the data layer, with row-level security as a second lock tested under the application's own database role (not the table owner, no `BYPASSRLS`), and downloads served through the authorizing route or a short user delegation SAS issued after the check.
- Real integrations. Nothing here connects to any accounting, CRM or agent system.

Prepared by Frederic de Lavenne de Choulot, The AI Pipe.
