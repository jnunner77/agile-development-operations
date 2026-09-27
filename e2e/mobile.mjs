// Mobile smoke test: drives the UI as an iPhone (small screen, touch, no hover) against a
// running server with demo data. Dragging isn't available on touch screens, so this checks
// the menu-based alternatives.
// Usage: BASE_URL=http://localhost:4000 node e2e/mobile.mjs
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';

const base = process.env.BASE_URL ?? 'http://localhost:4000';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const db = async () => (await (await fetch(base + '/api/bootstrap')).json()).db;
await page.goto(base + '/backlogs/requirements');
const row = page.locator('tr.grid-row', { hasText: 'Pay an invoice' });
// 1. Move to a sprint through the row menu (inline submenu)
await row.locator('.row-more').tap();
await page.locator('.menu-item', { hasText: 'Move to iteration' }).tap();
await page.locator('.submenu .menu-item', { hasText: 'Sprint 5' }).tap();
await page.waitForTimeout(400);
let item = (await db()).workItems.find((w) => w.title === 'Pay an invoice by card');
const s5 = (await db()).sprints.find((s) => s.name === 'Sprint 5');
assert.equal(item.iterationId, s5.id, 'moved to sprint 5');
// 2. Move up
const orderBefore = (await db()).workItems.filter((w) => w.type === 'Product Backlog Item' || w.type === 'Bug').filter((w) => w.state !== 'Done' && w.state !== 'Removed').sort((a, b) => a.stackRank - b.stackRank).map((w) => w.id);
await row.locator('.row-more').tap();
await page.locator('.menu-item', { hasText: 'Move up' }).tap();
await page.waitForTimeout(400);
const orderAfter = (await db()).workItems.filter((w) => w.type === 'Product Backlog Item' || w.type === 'Bug').filter((w) => w.state !== 'Done' && w.state !== 'Removed').sort((a, b) => a.stackRank - b.stackRank).map((w) => w.id);
assert.equal(orderAfter.indexOf(item.id), orderBefore.indexOf(item.id) - 1, 'moved up one');
// 3. Open the form by tapping the title, edit, save & close
await row.locator('.title-link').tap();
await page.locator('.wi-form').waitFor();
await page.getByLabel('Effort (story points)').fill('13');
await page.getByRole('button', { name: /Save & Close/ }).tap();
await page.locator('.wi-form').waitFor({ state: 'detached' });
item = (await db()).workItems.find((w) => w.id === item.id);
assert.equal(item.effort, 13, 'effort saved');
// 4. Planning pane opens stacked under the list
await page.locator('button[title="Planning pane"]').tap();
await page.locator('.planning-pane').waitFor();
const box = await page.locator('.planning-pane').boundingBox();
assert.ok(box.width > 350, 'pane is full width');
// 5. Taskboard: change a task's state through its menu
const sid = (await db()).sprints.find((s) => s.name === 'Sprint 3').id;
await page.goto(`${base}/sprints/${sid}/taskboard`);
const card = page.locator('.task-card', { hasText: 'Add regression tests' });
await card.locator('.card-more').tap();
await page.locator('.menu-item', { hasText: 'Change state' }).tap();
await page.locator('.submenu .menu-item', { hasText: 'In Progress' }).tap();
await page.waitForTimeout(400);
assert.equal((await db()).workItems.find((w) => w.title === 'Add regression tests').state, 'In Progress');
// 6. Bottom navigation
await page.locator('.bottomnav-link', { hasText: 'Boards' }).tap();
await page.waitForURL(/\/boards\//);
assert.deepEqual(errors, []);
console.log('Mobile smoke test passed');
await browser.close();
