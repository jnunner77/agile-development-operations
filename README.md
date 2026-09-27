# Boards — an Azure DevOps-style backlog & sprint manager

A self-hosted clone of the Azure DevOps **Boards** experience: product backlogs, Kanban boards,
sprints with taskboards, capacity planning with days off, and rich work items — plus snapshots
and backups of all your data.

Built with React, Express and TypeScript; data is stored as JSON on the server.

## Quick start

```bash
npm install
npm run build     # build the web client
npm start         # http://localhost:4000
```

(`npm start` without a build serves only the API.)

For development with hot reload (API on :4000, UI on :5173 with a proxy):

```bash
npm run dev
```

On first start the server creates `data/db.json` with a demo project (team, five sprints around
today's date, epics → features → backlog items → tasks, with history for burndown charts).
Start empty instead with `SEED=empty npm start`, or use **Project settings → Snapshots & backups → Reset**.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | HTTP port |
| `DATA_DIR` | `./data` | Where the database and snapshots are stored |
| `SEED` | `demo` | `demo` or `empty` — data created when no database exists yet |
| `AUTH_DISABLED` | _(unset)_ | Set to `1` to force sign-in off (recovery if every administrator is locked out) |

## Features

### Work items
- Types from the Scrum process: **Epic, Feature, Product Backlog Item, Bug, Task**, each with its own
  states (New → Approved → Committed → Done, To Do → In Progress → Done, …) and reasons.
- Fields: title, state, assigned to, area, iteration, **description**, **acceptance criteria**,
  **repro steps** & system info (bugs), priority, severity, **effort (story points)**, business value,
  time criticality, value area, risk, activity, blocked, **original estimate / remaining / completed
  work (hours)** with roll-up from children, start / target / **due dates**, found-in / integrated-in
  build and **tags** (with autocomplete).
- Rich-text editor (bold, italic, lists, code, links, pasted images) — all HTML is sanitized.
- **Parent / child hierarchy** (Epic → Feature → PBI/Bug → Task) with validation and cycle prevention.
- **Related links** (Related, Predecessor/Successor, Duplicate/Duplicate Of, Tests/Tested By) and
  hyperlinks.
- **Discussion** (comments with edit/delete) and a full **history** of every field change.
- Copy work item (optionally with children), delete to a **recycle bin**, restore.
- Shareable URLs: any page with `?wi=<id>` opens that work item.

### Backlogs (list view)
- Epics, Features and Backlog items levels, ordered by drag and drop (stack rank).
- Expand rows to see children; add child items inline with `+`.
- View options: show **parents** (hierarchy), in-progress items, completed children, items already
  planned in sprints; keyword/type/state/assignee/tag/iteration filters.
- Multi-select (Ctrl/Shift-click) with bulk move-to-sprint, assign, change state, re-parent, delete.
- **Planning pane**: drag items onto a sprint to plan them, or onto the backlog to move them back.
  Open child tasks travel with their parent.

### Boards (Kanban)
- Column per state for each backlog level; drag cards between columns and reorder within a column.
- Cards show assignee, effort, iteration, due date (overdue highlighted), tags and a child checklist.

### Sprints
- Create, edit (dates & sprint goal) and delete sprints; next sprint dates are suggested.
- **Taskboard**: rows per backlog item (or per person), To Do / In Progress / Done columns, drag tasks
  across columns and rows, inline remaining-hours editing, person filter.
- **Sprint backlog**: ordered list of the sprint's items and their tasks.
- **Move work out of a sprint**: any item's menu (right-click or `…`) on the taskboard or sprint
  backlog has **Move to next sprint** and **Move to backlog**; the sprint's `…` menu moves *all*
  unfinished work at once. Open tasks travel with their backlog item; finished work stays put.
- **Planning pane** on the taskboard and sprint backlog: drag a backlog item (or task) onto another
  sprint or the backlog.
- **Capacity**: per member activities & hours per day, **personal days off** and **team days off**
  (date ranges), copy from a previous sprint. Working days are configurable.
- **Work details** panel: remaining work vs. remaining capacity for the team, per activity and per person.
- **Analytics**: sprint burndown (reconstructed from history, with ideal trend and available capacity)
  and velocity across sprints.

### Sign-in (optional)
Off by default, so the app works as before with a "who am I" picker. To turn it on:

1. In **Project settings → Team members**, give each person a **username**.
2. In **Project settings → Authentication**, tick **Administrator** for at least one of them,
   then tick **Require people to sign in** and save.
3. Everyone signs in with their username. The first time, they leave the password blank and
   choose one. Until they do, anyone who types that username can set it, so tell people promptly
   (or have an administrator set a temporary password for them).

- **Passwords** are stored as salted scrypt hashes in `DATA_DIR/auth.json`, never in plain text and
  never sent to browsers, snapshots or backup exports. They must be at least 8 characters.
- **Expiry**: passwords expire after 60 days by default (configurable, or off). An expired password
  still works once, to choose a new one.
- **Session timeout**: people are signed out after 60 minutes of inactivity by default
  (configurable, 5 minutes to 7 days). Restarting the server signs everyone out.
- **Lockout**: 5 wrong passwords lock that username for 5 minutes.
- **Administrators** can change these settings, set a temporary or permanent password for anyone,
  reset a password (the person chooses a new one at next sign-in), make others administrators,
  and are the only ones who can change team members, project settings, restore snapshots, import
  backups or reset data. The app never lets you remove the last administrator who can sign in.
- **Locked out?** Start the server with `AUTH_DISABLED=1`, fix the accounts in Project settings,
  then restart without it.

Use HTTPS (for example behind a reverse proxy) if the app is reachable beyond your own machine;
otherwise passwords travel over the network unencrypted.

### Snapshots & backups
- **Snapshots**: named point-in-time copies of everything (items, history, comments, links, sprints,
  capacity, team, settings). Restore, rename, download or delete.
- **Automatic snapshots** on a schedule with retention (default: daily, keep 14).
- A **safety snapshot** is always taken before a restore, import or reset, so every one of those can be undone.
- **Export** the whole project as a JSON file and **import** it (or a downloaded snapshot) elsewhere.

### Collaboration
- Changes are pushed to every open browser instantly (server-sent events).
- Pick "who you are" in the top bar; it's recorded in history and comments.
  There is no authentication — run it on a trusted network or behind your own auth proxy.

## Architecture

```
shared/   Domain model shared by server and client: process template (types, states),
          types, date math, capacity & burndown calculations
server/   Express API. JSON document store (atomic writes to data/db.json), transactions that
          emit deltas, snapshot manager, demo seed
client/   React + Vite single-page app (zustand store, react-router)
tests/    Vitest unit & API tests
e2e/      Playwright smoke test that drives the UI
```

Every mutation runs in a transaction against a copy of the database; on success it is persisted and
the changed entities are returned as a *delta* and broadcast to other clients.

## Tests

```bash
npm run typecheck
npm test                          # unit + API tests
npm run build && npm start &      # then, against a fresh demo database:
BASE_URL=http://localhost:4000 npm run test:e2e
```

The e2e test uses Playwright's Chromium; set `CHROMIUM_PATH` to use a specific browser binary.
