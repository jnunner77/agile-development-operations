// End-to-end smoke test: drives the real UI in Chromium against a running server.
// Usage: BASE_URL=http://localhost:4000 node e2e/smoke.mjs   (server should use demo data)
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL ?? 'http://localhost:4000';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const api = async (path) => (await (await fetch(base + '/api' + path)).json());
const db = async () => (await api('/bootstrap')).db;
const step = (name) => console.log('•', name);

step('create a backlog item from the backlog page');
await page.goto(base + '/backlogs/requirements');
await page.getByRole('button', { name: /New Backlog item/ }).click();
await page.getByLabel('New work item title').fill('E2E: keyboard shortcuts');
await page.keyboard.press('Enter');
const row = page.locator('tr.grid-row', { hasText: 'E2E: keyboard shortcuts' });
await row.waitFor();
assert.equal((await row.locator('.col-order').textContent()).trim(), '1');
let item = (await db()).workItems.find((w) => w.title === 'E2E: keyboard shortcuts');
assert.ok(item);

step('drag it onto a sprint in the planning pane');
const target = (await db()).sprints.find((s) => s.name === 'Sprint 4');
await row.dragTo(page.locator('.plan-target', { hasText: 'Sprint 4' }));
await page.waitForTimeout(400);
item = (await db()).workItems.find((w) => w.id === item.id);
assert.equal(item.iterationId, target.id);

step('drag it back to the backlog');
await row.dragTo(page.locator('.plan-target.plan-backlog'));
await page.waitForTimeout(400);
assert.equal((await db()).workItems.find((w) => w.id === item.id).iterationId, null);

step('reorder by dragging below the second row');
const second = page.locator('tr.grid-row').nth(2);
await row.dragTo(second, { targetPosition: { x: 200, y: 30 } });
await page.waitForTimeout(400);
assert.equal((await row.locator('.col-order').textContent()).trim(), '3');

step('edit fields in the work item form and save');
await row.locator('.title-link').click();
await page.locator('.wi-form').waitFor();
await page.getByLabel('Effort (story points)').fill('5');
await page.locator('.wi-section', { hasText: 'Description' }).locator('.rte-content').first().click();
await page.keyboard.type('Users can press ? to see shortcuts.');
await page.locator('.wi-section', { hasText: 'Acceptance Criteria' }).locator('.rte-content').click();
await page.keyboard.type('Shortcut dialog lists all keys');
await page.getByRole('button', { name: /Add tag/ }).click();
await page.keyboard.type('Accessibility');
await page.keyboard.press('Enter');
await page.getByLabel('Due Date').fill('2026-12-01');
await page.getByRole('button', { name: /^Save$/ }).click();
await page.waitForTimeout(400);
item = (await db()).workItems.find((w) => w.id === item.id);
assert.equal(item.effort, 5);
assert.match(item.description, /press \? to see shortcuts/);
assert.match(item.acceptanceCriteria, /Shortcut dialog/);
assert.deepEqual(item.tags, ['Accessibility']);
assert.equal(item.dueDate, '2026-12-01');

step('comment and add a child task from the form');
await page.locator('.comment-new .rte-content').click();
await page.keyboard.type('Looks good to me');
await page.getByRole('button', { name: 'Comment', exact: true }).click();
await page.locator('.comment', { hasText: 'Looks good to me' }).waitFor();
await page.locator('.related-group', { hasText: 'Children' }).getByRole('button', { name: 'New' }).click();
await page.getByPlaceholder('New Task title').fill('Build shortcut dialog');
await page.keyboard.press('Enter');
await page.locator('.mini-item', { hasText: 'Build shortcut dialog' }).waitFor();

step('history tab shows the edit');
await page.getByRole('button', { name: /History/ }).click();
await page.locator('.history-entry').first().click();
await page.locator('.history-table', { hasText: 'Effort' }).waitFor();
await page.getByRole('button', { name: 'Close' }).last().click();
await page.locator('.wi-form').waitFor({ state: 'detached' });

step('taskboard: drag a task from To Do to In Progress');
const current = (await db()).sprints.find((s) => s.name === 'Sprint 3');
await page.goto(`${base}/sprints/${current.id}/taskboard`);
const card = page.locator('.task-card', { hasText: 'Test profile editing' });
const lane = page.locator('.tb-lane', { has: page.locator('.tb-parent-card', { hasText: 'Edit profile details' }) });
await card.dragTo(lane.locator('.tb-cell').nth(1));
await page.waitForTimeout(400);
assert.equal((await db()).workItems.find((w) => w.title === 'Test profile editing').state, 'In Progress');

step('taskboard: collapse a swimlane, remember it, then expand and collapse all');
const laneToggle = lane.locator('.tb-lane-header .expander');
await laneToggle.click();
await page.reload();
await lane.waitFor();
assert.match(await lane.getAttribute('class'), /\bcollapsed\b/);
assert.ok((await page.locator('.tb-lane:not(.collapsed)').count()) > 0);
await page.getByRole('button', { name: 'Collapse all' }).click();
assert.equal(await page.locator('.tb-lane:not(.collapsed)').count(), 0);
await page.getByRole('button', { name: 'Expand all' }).click();
assert.equal(await page.locator('.tb-lane.collapsed').count(), 0);

step('taskboard: change who a backlog item and a task are assigned to, right on the card');
const people = (await db()).members.filter((m) => m.active);
const parentCard = page.locator('.tb-parent-card', { hasText: 'Edit profile details' });
const parentId = (await db()).workItems.find((w) => w.title === 'Edit profile details').id;
const parentOwner = (await db()).workItems.find((w) => w.id === parentId).assignedTo;
const newOwner = people.find((m) => m.id !== parentOwner);
await parentCard.locator('.person-btn').click();
await page.locator('.menu .menu-item', { hasText: newOwner.name }).click();
await page.waitForTimeout(400);
assert.equal((await db()).workItems.find((w) => w.id === parentId).assignedTo, newOwner.id);
assert.equal(await page.locator('.wi-form').count(), 0, 'the item did not open');
await parentCard.locator('.person-name', { hasText: newOwner.name }).waitFor();
// By keyboard on a task card: Enter opens the list on the current assignee, End moves to the
// last member, Enter picks it; Esc closes and gives focus back to the button.
const taskBtn = card.locator('.person-btn');
await taskBtn.focus();
await page.keyboard.press('Enter');
await page.locator('.menu').waitFor();
assert.ok(await page.evaluate(() => !!document.activeElement?.closest('.menu')), 'menu has focus');
await page.keyboard.press('End');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
assert.equal((await db()).workItems.find((w) => w.title === 'Test profile editing').assignedTo, people[people.length - 1].id);
await taskBtn.focus();
await page.keyboard.press('Enter');
await page.locator('.menu').waitFor();
await page.keyboard.press('Escape');
await page.locator('.menu').waitFor({ state: 'detached' });
assert.ok(await taskBtn.evaluate((el) => el === document.activeElement), 'focus back on the assignee');

step('capacity: add days off and save');
await page.goto(`${base}/sprints/${current.id}/capacity`);
const alexRow = page.locator('.capacity-grid tr', { hasText: 'Alex Johnson' });
await alexRow.getByRole('button', { name: /0 days/ }).click();
await page.getByLabel('Start').fill(current.finishDate);
await page.getByLabel('End').fill(current.finishDate);
await page.locator('.range-add').getByRole('button', { name: 'Add' }).click();
await page.getByRole('button', { name: 'Done' }).click();
await page.getByRole('button', { name: /^Save$/ }).click();
await page.waitForTimeout(400);
const cap = (await db()).capacities.find((c) => c.sprintId === current.id);
const alex = (await db()).members.find((m) => m.name === 'Alex Johnson');
assert.deepEqual(cap.members.find((m) => m.memberId === alex.id).daysOff, [{ start: current.finishDate, end: current.finishDate }]);

step('sprint backlog: show and hide columns, remembered after a reload, then reset');
await page.goto(`${base}/sprints/${current.id}/backlog`);
const headers = () => page.locator('.backlog-grid thead th').allTextContents().then((t) => t.map((s) => s.trim()).filter(Boolean));
const defaultHeaders = ['Order', 'Title', 'State', 'Assigned To', 'Effort', 'Remaining Work', 'Activity', 'Tags'];
assert.deepEqual(await headers(), defaultHeaders);
await page.getByRole('button', { name: 'Column options' }).click();
const picker = page.getByRole('group', { name: 'Columns' });
assert.ok(await picker.getByLabel('Title').isDisabled(), 'Title is always shown');
await picker.getByLabel('ID').check();
await picker.getByLabel('Tags').uncheck();
await picker.getByLabel('Original Estimate').check();
assert.ok(await picker.isVisible(), 'the picker stays open while picking');
await page.keyboard.press('Escape');
await picker.waitFor({ state: 'detached' });
const pickedHeaders = ['Order', 'ID', 'Title', 'State', 'Assigned To', 'Effort', 'Original Estimate', 'Remaining Work', 'Activity'];
assert.deepEqual(await headers(), pickedHeaders);
const editProfile = (await db()).workItems.find((w) => w.title === 'Edit profile details');
const idCell = page.locator('tr.grid-row', { hasText: 'Edit profile details' }).first().locator('td').nth(2);
assert.equal((await idCell.textContent()).trim(), String(editProfile.id));
await page.reload();
assert.deepEqual(await headers(), pickedHeaders);
await page.getByRole('button', { name: 'Column options' }).click();
await page.getByRole('button', { name: 'Reset to defaults' }).click();
assert.deepEqual(await headers(), defaultHeaders);
assert.ok(await page.getByRole('button', { name: 'Reset to defaults' }).isDisabled());
await page.mouse.click(5, 5);
await picker.waitFor({ state: 'detached' });

step('board: drag a card between columns');
await page.setViewportSize({ width: 1440, height: 2400 }); // keep source and target on screen while dragging
await page.goto(base + '/boards/requirements');
await page.locator('.card', { hasText: 'Dark mode for the portal' }).dragTo(page.locator('.board-column', { hasText: 'Approved' }).locator('.board-column-body'));
await page.waitForTimeout(400);
assert.equal((await db()).workItems.find((w) => w.title === 'Dark mode for the portal').state, 'Approved');

step('board: unassign a card right on the card');
const darkCard = page.locator('.card', { hasText: 'Dark mode for the portal' });
await darkCard.locator('.person-btn').click();
await page.locator('.menu .menu-item', { hasText: 'Unassigned' }).click();
await page.waitForTimeout(400);
assert.equal((await db()).workItems.find((w) => w.title === 'Dark mode for the portal').assignedTo, null);
await darkCard.locator('.person-name', { hasText: 'Unassigned' }).waitFor();

step('board: expand and collapse all cards, and remember a collapsed card');
const checklists = page.locator('.card .checklist-item');
const withKids = page.locator('.card', { has: page.locator('.card-children .link-btn') });
assert.equal(await checklists.count(), 0);
await page.getByRole('button', { name: 'Expand all' }).click();
assert.ok((await checklists.count()) > 0);
const firstCard = withKids.first();
const firstTitle = (await firstCard.locator('.card-title').textContent()).trim();
await firstCard.locator('.card-children .link-btn').first().click();
assert.equal(await firstCard.locator('.checklist-item').count(), 0);
await page.reload();
const reloaded = page.locator('.card', { hasText: firstTitle });
await reloaded.waitFor();
assert.equal(await reloaded.locator('.checklist-item').count(), 0);
assert.ok((await checklists.count()) > 0);
await page.getByRole('button', { name: 'Collapse all' }).click();
assert.equal(await checklists.count(), 0);

step('live updates reach a second browser tab');
const other = await browser.newPage();
await other.goto(base + '/boards/requirements');
await other.locator('.card', { hasText: 'Dark mode for the portal' }).waitFor();
await fetch(base + '/api/workitems/' + (await db()).workItems.find((w) => w.title === 'Dark mode for the portal').id, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Dark mode (renamed elsewhere)' }),
});
await other.locator('.card', { hasText: 'Dark mode (renamed elsewhere)' }).waitFor({ timeout: 5000 });
await other.close();

step('backlog: Ctrl-click two rows, move them to the bottom and tag them together');
await page.goto(base + '/backlogs/requirements');
const levelRows = page.locator('tr.grid-row.row-level');
const rowId = async (r) => {
  const title = (await r.locator('.title-link').textContent()).trim();
  return (await db()).workItems.find((w) => w.title === title).id;
};
const [pickA, pickB] = [levelRows.nth(0), levelRows.nth(2)];
const [idA, idB] = [await rowId(pickA), await rowId(pickB)];
await pickA.locator('.col-order').click();
await pickB.locator('.col-order').click({ modifiers: ['ControlOrMeta'] });
assert.equal(await page.locator('tr.grid-row.selected').count(), 2);
await page.getByRole('button', { name: /2 selected/ }).click();
await page.locator('.menu-item', { hasText: 'Move to bottom' }).click();
await page.waitForTimeout(400);
const openPbis = (await db()).workItems.filter((w) => ['Product Backlog Item', 'Bug'].includes(w.type) && !['Done', 'Removed'].includes(w.state)).sort((a, b) => a.stackRank - b.stackRank).map((w) => w.id);
assert.deepEqual(openPbis.slice(-2), [idA, idB], 'both at the bottom, in their order');
await page.getByRole('button', { name: /2 selected/ }).click();
await page.locator('.menu-item', { hasText: 'Add tags' }).click();
await page.getByLabel('Tags to add').fill('Bulk, Q4');
await page.getByRole('button', { name: 'Add tags', exact: true }).click();
await page.waitForTimeout(400);
for (const id of [idA, idB]) assert.deepEqual((await db()).workItems.find((w) => w.id === id).tags.slice(-2), ['Bulk', 'Q4']);

step('snapshot, change, restore');
await page.goto(base + '/settings/backups');
await page.getByLabel('Snapshot name').fill('E2E baseline');
await page.getByRole('button', { name: /Take snapshot/ }).click();
const snapRow = page.locator('tr', { hasText: 'E2E baseline' });
await snapRow.waitFor();
const before = (await db()).workItems.length;
await fetch(base + '/api/workitems', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'Bug', title: 'E2E: will be rolled back' }) });
assert.equal((await db()).workItems.length, before + 1);
await snapRow.getByRole('button', { name: /Restore/ }).click();
await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
await page.locator('tr', { hasText: 'Before restoring "E2E baseline"' }).waitFor();
assert.equal((await db()).workItems.length, before);

assert.deepEqual(errors, [], 'browser errors');

// Last, because it turns sign-in on (and back off, so other smoke tests can use the server).
// Its own page: requests refused while signed out are expected here, so only page errors count.
step('turning sign-in on lists API tokens and revokes them');
const json = { 'Content-Type': 'application/json' };
const send = async (method, path, body, headers = {}) =>
  fetch(base + '/api' + path, { method, headers: { ...json, ...headers }, body: body && JSON.stringify(body) });
const team = (await db()).members;
const admin = team.find((m) => m.username === 'alex');
const tokenOwner = team.find((m) => m.username === 'priya');
await send('PATCH', `/auth/accounts/${admin.id}`, { isAdmin: true });
await send('POST', `/auth/accounts/${admin.id}/password`, { password: 'smoke test password', mustChange: false });
const { token: secret } = await (await send('POST', '/auth/tokens', { name: 'E2E token', memberId: tokenOwner.id, scope: 'read' })).json();
assert.equal((await send('GET', '/bootstrap', undefined, { Authorization: `Bearer ${secret}` })).status, 200);
const auth = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const authErrors = [];
auth.on('pageerror', (e) => authErrors.push(e.message));
await auth.goto(base + '/settings/authentication');
await auth.getByLabel('Require people to sign in').check();
await auth.getByRole('button', { name: 'Save' }).click();
const confirm = auth.getByRole('dialog');
await confirm.getByText('E2E token').waitFor();
assert.ok(await confirm.getByRole('checkbox').isChecked(), 'revoking is ticked by default');
await confirm.getByRole('button', { name: 'Turn on sign-in' }).click();
await auth.getByRole('heading', { name: 'Sign in' }).waitFor();
assert.equal((await send('GET', '/bootstrap', undefined, { Authorization: `Bearer ${secret}` })).status, 401, 'token revoked');
await auth.getByLabel('Username').fill('alex');
await auth.getByLabel('Password').fill('smoke test password');
await auth.getByRole('button', { name: 'Sign in' }).click();
await auth.getByRole('heading', { name: 'Sign in' }).waitFor({ state: 'detached' });
const off = await auth.evaluate(async () => (await fetch('/api/auth/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":false}' })).status);
assert.equal(off, 200, 'sign-in turned back off');
assert.deepEqual(authErrors, [], 'page errors while turning sign-in on');
await auth.close();

await browser.close();
console.log('E2E smoke test passed');
