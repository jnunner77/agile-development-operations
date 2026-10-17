# Working in this repository

Boards is a self-hosted Azure DevOps-style backlog, board and sprint tool: a React + Vite
client (`client/`) and a TypeScript server with a JSON file store. The server follows an onion
architecture in `src/` (shared, domain, application, infrastructure, presentation); the features
not yet moved there (GitHub, snapshots and backups) still run on the Express code in `server/`.
See `README.md` for features and the architecture, and `deploy/README.md` for hosting.

## Workflow

- Never commit or push directly to `main`. Every change goes on its own branch cut from the
  latest `main`, and is merged back through a pull request.
- Before pushing, run and pass: `npm run typecheck`, `npm test`, and `npm run build`. For UI
  changes, also run the browser smoke test (`npm run build && npm start`, then
  `BASE_URL=http://localhost:4000 npm run test:e2e` and `npm run test:e2e:mobile` against a
  fresh demo database). UI must keep working on phones: check small screens (≤ 640px) and
  give every drag-and-drop action a menu alternative for touch screens.

## Link your work to work items

The app links branches, commits and pull requests to work items from GitHub webhooks.
When a change is for a work item (e.g. #123, "Offline indicator banner"):

- Name the branch `wi/<id>-<short-title>`, e.g. `wi/123-offline-indicator-banner`.
  Every commit pushed to that branch is linked to the item.
- Mention `AB#<id>` in the pull request title or description (e.g. "Closes AB#123"), and in
  commit messages on branches not named after the item. Several items: `AB#12 AB#34`.
- Opening a non-draft pull request moves linked backlog items to Committed and tasks to In
  Progress; merging into `main` moves them to Done. Use a draft pull request if the work
  isn't ready to move yet.

## Managing work items through the API

When the session has `BOARDS_URL` and `BOARDS_TOKEN` environment variables, you can read and
change the team's work items directly (create PBIs, tasks and bugs, move them between
sprints, update state, comment). `docs/api.md` lists the endpoints with `curl` examples.

- Send the token as `Authorization: Bearer $BOARDS_TOKEN`. Never print it, log it, commit it
  or put it in a URL.
- Tokens can't change sign-in, team members, settings, integrations or backups; ask a person.
- Link code to the items you work on as described above, so pull requests move them along.
- Assign every Task to Claude (the member the token acts as, `GET /api/auth/status`) and every
  PBI, Bug, Feature and Epic to Justin Nunner (`jnunner77`). Close your tasks (Done) once their
  work is merged; a merge doesn't do it for pull requests in other repositories.

## Code conventions

- TypeScript everywhere. The server runs on plain Node 22.18+ (type stripping), so use `.ts`
  extensions in imports and only erasable syntax: no `enum`, `namespace` or constructor
  parameter properties.
- Server code follows the `onion-architecture-ts` skill. Each layer in `src/` is its own
  TypeScript project and may only import the layers inside it (`#shared/…`, `#domain/…`,
  `#application/…`); `tsc -b` fails otherwise. Fix such errors by adding a port, never by
  widening a tsconfig's `references` or `include`.
  - `domain/`: business rules in aggregates and value objects, no Node or browser APIs. Expected
    failures are returned as `Result` errors with a `code`, never thrown. Time and ids are passed in.
  - `application/`: one use case class per file with an `execute` method; ports for anything
    external. Use cases orchestrate; rules belong in the domain.
  - `infrastructure/`: adapters that implement the ports. `presentation/`: `node:http` routes with
    hand-written parsers, and an exhaustive switch (ending in `assertNever`) from error codes to
    HTTP statuses.
  - `src/compose.ts` is the only place that knows the concrete classes.
  - Who may administer the project is decided in the application (`requireAdmin`,
    `adminAccessOf`); routes that need it check before reading the request, as the Express routes
    did. Who is calling comes from `IdentifyCaller` (session cookie or API token), and
    `presentation/sign-in/gate.ts` decides which requests need signing in, also for `server/`.
- No new runtime dependencies in `src/`. Express and zod remain only in `server/` until the
  features there move into the layers. Move one feature at a time, as the work items slice did.
- Every change runs as one unit of work (`StoreUnitOfWork` over `store.transactAsync`, or
  `store.transact` in `server/`), so it is validated, persisted, recorded in work item history
  and broadcast to browsers as deltas, or not applied at all.
- Secrets (password hashes, API token digests, webhook secrets) live in their own files in the
  data directory (`auth.json`, `api-tokens.json`, written 0600), never in `db.json`, snapshots,
  exports or API responses. Sessions and failed sign-in counts stay in memory.
- No non-null assertions (`!`), `any`, or casts except branding ids at trust boundaries and typing
  raw JSON in infrastructure (which the domain then validates).
- Tests: `node:test` tests in `tests/<layer>/` for code in `src/` (domain without fakes;
  application with the in-memory adapters in `src/infrastructure/memory/`). The vitest suites
  in `tests/legacy/` drive the whole app over HTTP; keep them passing.
