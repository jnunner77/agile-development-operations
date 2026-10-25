---
name: boards-tickets
description: Create and update the Boards tickets (PBI or Bug, with tasks) for any change to this repository. Use BEFORE starting any work (code, docs, config, fixes), and again when opening a pull request, after a merge, and when a change is confirmed on the live Boards server.
---

# Boards tickets

Every change starts from a ticket in Boards (the team's backlog at `$BOARDS_URL`, API in
[`docs/api.md`](../../../docs/api.md)). No code, docs or config change begins until its PBI or Bug
and its tasks exist.

`boards.py` next to this file does the API calls (it needs `BOARDS_URL` and `BOARDS_TOKEN`; never
print, log or commit the token, or put it in a URL). If either is missing, stop and ask the user to
add them to the environment; don't start the work without a ticket. Tokens can't change sign-in,
team members, settings, integrations or backups: ask a person.

```bash
B=.claude/skills/boards-tickets/boards.py
python3 $B whoami                         # token acts as Claude; current sprint
python3 $B create /path/to/spec.json      # PBI or Bug + tasks; prints the ids
python3 $B state "In Progress" 112        # several ids allowed
python3 $B link 110 https://github.com/jnunner77/agile-development-operations/pull/38 "Pull request #38"
python3 $B comment 110 "<p>Done in …</p>"
python3 $B show 110                       # the item and its tasks
python3 $B brief 110                      # description, acceptance criteria and tasks as text
```

## 1. Before any work: create the ticket

- **PBI** (`"Product Backlog Item"`) for new or changed behaviour; **Bug** for something broken.
  Several unrelated asks get one ticket each.
- The spec comes from the planner's plan (`model-roles` skill). Write it in the scratchpad, not
  the repo. `boards.py create` assigns the PBI/Bug to Justin Nunner and the tasks to Claude, puts
  all of them in the current sprint, priority 2.

```json
{
  "type": "Product Backlog Item",
  "title": "Boards: <what it does, in the user's words>",
  "effort": 3,
  "tags": ["boards", "<area: ux, architecture, security, ...>"],
  "description": "<p>As a team member, I want …, so that ….</p>",
  "acceptanceCriteria": "<ul><li>…</li><li>Works on phones (≤ 640px); drag-and-drop actions have a menu alternative.</li></ul>",
  "tasks": [
    {"title": "<the build step: client, server layer, tests>", "activity": "Development"},
    {"title": "Validate on the live Boards server", "activity": "Testing"}
  ]
}
```

For a Bug, use `"type": "Bug"`, `reproSteps` (HTML: steps, expected, actual) instead of
`description` (Bugs have no description; `acceptanceCriteria` still works), a `severity` of
`"1 - Critical"`, `"2 - High"`, `"3 - Medium"` or `"4 - Low"`, and priority 1 if it breaks
something people use. Title prefix `Boards:` and tag `boards` always, plus one or more areas as
the backlog uses them: `ux`, `architecture`, `security`, `integrations`, `live-updates`,
`backups`, `operations`, `tests`, `workflow`. Effort is story points (1, 2, 3, 5, 8). Split
development into 1–3 tasks by real steps (by layer, for example: "Domain: …", "Application: …",
"Client: …", "Docs: README and CLAUDE.md").

End with the Testing task "Validate on the live Boards server" for every Bug and every change
people see in the app or the API. Leave it out for changes that don't reach the running server's
behaviour (internal refactors, tests, docs, this repository's workflow).

Tell the user the ticket numbers (e.g. "AB#113 with tasks AB#114–AB#116") before starting.

## 2. While working

- Set a task to `In Progress` when you start it: `boards.py state "In Progress" <task>`.
- Name the work in commits and pull requests with `AB#<id>`: the commit message ends its subject
  with `(AB#<pbi> AB#<task> …)`.
- Name the branch after the item: `wi/<id>-<short-title>`, a few lowercase words for what it
  implements (`wi/489-sprint-backlog-columns`, `wi/343-stale-live-updates`). Do this even when
  the session suggests another branch name (a `claude/…` one): the owner asked for it.
- Title the pull request with what it implements, in plain words, ending with `(AB#<pbi>)`
  (`Column options for the sprint backlog (AB#489)`), and start its description with
  `AB#<pbi>` and its tasks. If a pull request was opened for you with another title, retitle it.
- New work found along the way (another bug, a follow-up) gets its own ticket; mention it to the
  user rather than widening the current change.

How Boards moves items: pushes and pull requests reach Boards through its GitHub webhook. The
`wi/<id>` branch links the PBI/Bug, and `AB#<id>` in a commit links that task. Opening a non-draft
pull request moves linked PBIs/Bugs to Committed and tasks to In Progress; merging into `main`
moves them to Done. Only linked items move, so the "Validate on the live Boards server" task
(never named in commits) stays open.

## 3. Pull request opened and merged

- Before opening it, the pushed branch must pass the `review-loop` skill: the `code-reviewer` agent
  reviews it against this ticket (`boards.py brief <id>` prints the description, acceptance criteria
  and tasks to hand it) until it passes with no findings, or until the eighth review fails and its
  findings have a ticket of their own.
- When the PR is opened: `link <pbi> <PR url> "Pull request #N"` and a comment saying what was
  done and how it was tested.
- After the merge: `boards.py show <pbi>`, and set any linked PBI/Bug and Development task that
  didn't move to `Done` (the webhook may be off or have missed it).
- A ticket with a "Validate on the live Boards server" task: leave that task open until the user
  confirms the change works on the live Boards server (after it's redeployed,
  [`deploy/README.md`](../../../deploy/README.md)). Then set it `Done` and comment who confirmed
  it. The PBI/Bug and the Development tasks are already `Done` from the merge. A ticket without
  such a task is finished at the merge.
