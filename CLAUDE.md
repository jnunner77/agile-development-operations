# Working in this repository

Boards is a self-hosted Azure DevOps-style backlog, board and sprint tool: a React + Vite
client (`client/`) and a TypeScript server with a JSON file store. The server follows an onion
architecture in `src/` (shared, domain, application, infrastructure, presentation) on plain Node:
no runtime dependencies, and the request pipeline (rate limits, live updates, static files) is
`src/presentation/http/pipeline/`.
See `README.md` for features and the architecture, and `deploy/README.md` for hosting.

## Tickets first

Before starting any work (a feature, a fix, docs, config, even a one-line change), create its
ticket in Boards: a **PBI** for new or changed behaviour, or a **Bug** for something broken, with its
**tasks**. Follow the `boards-tickets` skill (`.claude/skills/boards-tickets/`), which creates them
through the Boards API (`BOARDS_URL`, `BOARDS_TOKEN`), and tell the user the AB# numbers before
writing code. If the API isn't reachable, stop and ask; don't start without a ticket.

Link the work to it as below; task states kept current (In Progress when started, Done when
merged), and a ticket with a "Validate on the live Boards server" task stays open until the change
is confirmed on the live server.

## Who does what

Every change is split across models the same way, whatever model the session runs on: follow the
`model-roles` skill (`.claude/skills/model-roles/`). The session coordinates and passes `model` on
every Agent call; it doesn't plan or write the change itself.

- **Opus plans**: the `planner` agent (`.claude/agents/planner.md`) writes the plan and the ticket's
  spec, and answers every architecture and implementation question. Only what needs the user's own
  decision goes to the user.
- **Sonnet implements**: the `implementer` agent (`.claude/agents/implementer.md`) writes the code,
  runs the checks, commits, and fixes review findings. It sends questions to the planner, not the
  user.
- **Haiku reviews**: the `code-reviewer` agent, through the `review-loop` skill.
- If the fifth review still doesn't pass, Opus takes over the fixes for three more rounds (it fixes
  the findings of reviews 5-7). If the eighth review doesn't pass, its findings get their own
  ticket and the pull request is opened anyway.
- When the session was started in another repository's checkout, agents and skills with these
  names may be that repository's: use this repository's files under `.claude/` (the skills say
  how).

## Workflow

- Never commit or push directly to `main`. Every change goes on its own branch cut from the
  latest `main`, and is merged back through a pull request. The branch is `wi/<id>-<short-title>`
  after its ticket, even when the session suggests another name.
- Before pushing, run and pass: `npm run typecheck`, `npm test`, and `npm run build`. For UI
  changes, also run the browser smoke test (`npm run build && npm start`, then
  `BASE_URL=http://localhost:4000 npm run test:e2e` and `npm run test:e2e:mobile` against a
  fresh demo database). UI must keep working on phones: check small screens (≤ 640px) and
  give every drag-and-drop action a menu alternative for touch screens.
- Every push is reviewed before it becomes (or updates) a pull request: follow the `review-loop`
  skill (`.claude/skills/review-loop/`). It spawns the `code-reviewer` agent
  (`.claude/agents/code-reviewer.md`, on the cheapest model, Haiku) with the diff and the ticket's
  description, acceptance criteria and tasks; the implementer fixes its findings, and the branch is
  pushed and reviewed again until it passes with no findings (or the eighth fails, as above), and
  only then is the pull request opened. Don't ask GitHub Copilot to review pull requests: the
  owner turned that off.
- Update `README.md` when a feature changes what people see, and `docs/api.md` when the API
  changes.

## Link your work to work items

The app links branches, commits and pull requests to work items from GitHub webhooks.
Every change is for a work item (see Tickets first), e.g. #123, "Offline indicator banner":

- Name the branch `wi/<id>-<short-title>`, e.g. `wi/123-offline-indicator-banner`.
  Every commit pushed to that branch is linked to the item.
- Mention `AB#<id>` in the pull request title or description (e.g. "Closes AB#123"), and in
  commit messages on branches not named after the item. Several items: `AB#12 AB#34`.
- Opening a non-draft pull request moves linked backlog items to Committed and tasks to In
  Progress; merging into `main` moves them to Done. Use a draft pull request if the work
  isn't ready to move yet. Open pull requests only once the review loop passes; they're never
  drafts then.

## Managing work items through the API

When the session has `BOARDS_URL` and `BOARDS_TOKEN` environment variables, you can read and
change the team's work items directly (create PBIs, tasks and bugs, move them between
sprints, update state, comment). `.claude/skills/boards-tickets/boards.py` wraps the calls this
workflow needs (whoami, create, state, link, comment, show, brief); `docs/api.md` lists every
endpoint with `curl` examples.

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
    `adminAccessOf`); routes that need it check before reading the request. Who is
    calling comes from `IdentifyCaller` (session cookie or API token), and
    `presentation/sign-in/gate.ts` decides which requests need signing in.
- No runtime dependencies on the server: only Node's built-in modules. Libraries the client needs
  are dev dependencies, bundled by Vite, so the production image installs nothing.
- Every change runs as one unit of work (`StoreUnitOfWork` over `store.transactAsync`), so it is
  validated, persisted, recorded in work item history and broadcast to browsers as deltas, or not
  applied at all. Replacing the whole project (restore, import, reset) runs exclusively through
  the `ProjectStore` port, after a safety snapshot.
- Secrets (password hashes, API token digests, webhook secrets) live in their own files in the
  data directory (`auth.json`, `api-tokens.json`, `integrations.json`, written 0600), never in
  `db.json`, snapshots, exports or API responses. Sessions, failed sign-in counts and recent
  webhook deliveries stay in memory.
- No non-null assertions (`!`), `any`, or casts except branding ids at trust boundaries and typing
  raw JSON in infrastructure (which the domain then validates).
- Tests: `node:test` tests in `tests/<layer>/` for code in `src/` (domain without fakes;
  application with the in-memory adapters in `src/infrastructure/memory/`). The suites in
  `tests/app/` drive the whole app over HTTP through `tests/app/support/` (`expect` matchers and a
  `request(app)` client); keep them passing. Everything runs on `node:test`.
