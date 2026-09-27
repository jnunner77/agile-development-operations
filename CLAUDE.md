# Working in this repository

Boards is a self-hosted Azure DevOps-style backlog, board and sprint tool: a React + Vite
client (`client/`), an Express API with a JSON file store (`server/`), and domain code
shared by both (`shared/`). See `README.md` for features and `deploy/README.md` for hosting.

## Workflow

- Never commit or push directly to `main`. Every change goes on its own branch cut from the
  latest `main`, and is merged back through a pull request.
- Before pushing, run and pass: `npm run typecheck`, `npm test`, and `npm run build`. For UI
  changes, also run the browser smoke test (`npm run build && npm start`, then
  `BASE_URL=http://localhost:4000 npm run test:e2e` against a fresh demo database).

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

## Code conventions

- TypeScript everywhere; keep `shared/` free of Node- and browser-specific code.
- Server mutations go through `store.transact(...)` so they are validated, persisted,
  recorded in work item history and broadcast to browsers as deltas. Validate request
  bodies with zod.
- Secrets (passwords, webhook secrets) live in their own files in the data directory,
  never in `db.json`, snapshots, exports or API responses.
- Add or update tests in `tests/` for server and shared logic.
