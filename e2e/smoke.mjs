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
await browser.close();
console.log('E2E smoke test passed');
