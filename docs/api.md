# Boards API

Everything the web app does goes through a JSON API under `/api`. Scripts and assistants
use it with an **API token** (Project settings → API tokens).

```bash
export BOARDS_URL=https://yourteam.duckdns.org
export BOARDS_TOKEN=boards_...        # from a secret store, never committed or pasted in chat
auth=(-H "Authorization: Bearer $BOARDS_TOKEN" -H "Content-Type: application/json")
```

- A token acts as one team member: history and comments show that member's name.
- **Read-only** tokens can only `GET`. **Read & write** tokens can also create and change
  work items, sprints and capacity.
- Tokens can never manage sign-in, tokens, team members, project settings, integrations,
  snapshot restores, imports or resets (403).
- A wrong or expired token gets `401`; repeated bad tokens block the IP address for an hour.
- Requests are rate limited (about 600 a minute, 240 changes a minute). A `429` response has
  a `Retry-After` header.
- Errors are `{"error": "message"}`.

## Reading

| Request | Returns |
| --- | --- |
| `GET /api/auth/status` | Who the token acts as (`user`) |
| `GET /api/bootstrap` | `{ db }`: `members`, `sprints`, `capacities`, `workItems`, `links`, `settings` |

Useful lookups with `jq`:

```bash
db=$(curl -s "${auth[@]}" "$BOARDS_URL/api/bootstrap")
# Current sprint (today between its start and finish dates)
echo "$db" | jq -r --arg d "$(date +%F)" '.db.sprints[] | select(.startDate <= $d and .finishDate >= $d) | "\(.id) \(.name)"'
# Team members
echo "$db" | jq -r '.db.members[] | "\(.id) \(.name)"'
# A work item
echo "$db" | jq '.db.workItems[] | select(.id == 42)'
```

## Work items

Types: `Epic`, `Feature`, `Product Backlog Item`, `Bug`, `Task`. States: Epic/Feature
`New · In Progress · Done · Removed`; PBI/Bug `New · Approved · Committed · Done · Removed`;
Task `To Do · In Progress · Done · Removed`.

| Request | Body |
| --- | --- |
| `POST /api/workitems` | `{ "type", "title", ...fields, "position": "top" \| "bottom" }` |
| `PATCH /api/workitems/:id` | any fields to change |
| `POST /api/workitems/:id/move` | `{ "iterationId"?, "parentId"?, "state"?, "assignedTo"?, "afterId"?, "beforeId"? }` |
| `POST /api/workitems/bulk` | `{ "ids": [..], "changes": {..}, "addTags"?: [..], "removeTags"?: [..] }` |
| `DELETE /api/workitems/:id` | moves it to the recycle bin |
| `POST /api/workitems/:id/comments` | `{ "text": "<p>HTML</p>" }` |
| `POST /api/workitems/:id/hyperlinks` | `{ "url", "comment"? }` |
| `POST /api/links` | `{ "sourceId", "targetId", "type": "Related" \| "Predecessor" \| … }` |

Fields: `title`, `state`, `assignedTo` (member id), `iterationId` (sprint id, `null` = backlog),
`parentId`, `priority` (1–4), `effort` (story points), `businessValue`, `timeCriticality`,
`valueArea`, `risk`, `severity`, `activity`, `blocked`, `originalEstimate` / `remainingWork` /
`completedWork` (hours), `startDate` / `targetDate` / `dueDate` (`YYYY-MM-DD`), `description`,
`acceptanceCriteria`, `reproSteps`, `systemInfo` (HTML), `foundInBuild`, `integratedInBuild`, `tags`.

Every change response is `{ "delta": {...}, "result": <the item> }`.

Example: a PBI in the current sprint, then a task under it.

```bash
sprint=$(echo "$db" | jq -r --arg d "$(date +%F)" '.db.sprints[] | select(.startDate <= $d and .finishDate >= $d) | .id')
pbi=$(curl -s "${auth[@]}" -X POST "$BOARDS_URL/api/workitems" -d "$(jq -n --arg s "$sprint" '{
  type: "Product Backlog Item", title: "Set up the file explorer site", iterationId: $s, effort: 5,
  description: "<p>Why and what.</p>", acceptanceCriteria: "<ul><li>Done when…</li></ul>", tags: ["Infrastructure"] }')" | jq .result.id)
curl -s "${auth[@]}" -X POST "$BOARDS_URL/api/workitems" \
  -d "{\"type\":\"Task\",\"title\":\"Provision storage\",\"parentId\":$pbi,\"originalEstimate\":4}" | jq .result.id
```

## Sprints and capacity

| Request | Body |
| --- | --- |
| `POST /api/sprints` | `{ "name", "startDate", "finishDate", "goal"? }` |
| `PATCH /api/sprints/:id` | fields to change |
| `PUT /api/sprints/:id/capacity` | `{ "teamDaysOff": [{start,end}], "members": [{ memberId, activities: [{activity, capacityPerDay}], daysOff: [{start,end}] }] }` |
