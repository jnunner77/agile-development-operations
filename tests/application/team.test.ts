import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UpdateSettings } from '#application/settings/update-settings.ts';
import { CopyCapacity } from '#application/sprints/copy-capacity.ts';
import { CreateSprint } from '#application/sprints/create-sprint.ts';
import { DeleteSprint } from '#application/sprints/delete-sprint.ts';
import { SetCapacity } from '#application/sprints/set-capacity.ts';
import { UpdateSprint } from '#application/sprints/update-sprint.ts';
import { CreateMember } from '#application/team/create-member.ts';
import { DeleteMember } from '#application/team/delete-member.ts';
import { UpdateMember } from '#application/team/update-member.ts';
import { SignInSettingsChanges } from '#domain/sign-in/settings.ts';
import { NOW, ann, bo, setup, tokenCaller, unwrap } from './fixtures.ts';

const plan = (memberId: string, hours: number, daysOff: { start: string; end: string }[] = []) => ({
  teamDaysOff: [],
  members: [{ memberId, activities: [{ activity: 'Development', capacityPerDay: hours }], daysOff }],
});

describe('sprints', () => {
  it('start with the previous sprint’s people and activities', async () => {
    const t = setup();
    unwrap(await new SetCapacity(t.deps).execute({ caller: ann, sprintId: 's2', ...plan('m1', 6, [{ start: '2026-01-20', end: '2026-01-20' }]) }));
    const s3 = unwrap(await new CreateSprint(t.deps).execute({ caller: ann, name: ' Sprint 3 ', startDate: '2026-02-02', finishDate: '2026-02-13' })).result;
    assert.equal(s3.name, 'Sprint 3');
    const carried = t.capacities.rows().find((c) => c.sprintId === s3.id);
    assert.deepEqual(carried?.members, [{ memberId: 'm1', activities: [{ activity: 'Development', capacityPerDay: 6 }], daysOff: [] }]);
    assert.deepEqual(
      t.published.map((e) => e.type),
      ['CapacityChanged', 'SprintCreated'],
    );
  });

  it('refuse a duplicate name or bad dates, saving nothing', async () => {
    const t = setup();
    const create = new CreateSprint(t.deps);
    assert.deepEqual(await create.execute({ caller: ann, name: 'sprint 1' }), { ok: false, error: { code: 'SPRINT_NAME_TAKEN', name: 'sprint 1' } });
    assert.deepEqual(await create.execute({ caller: ann, name: 'Bad', startDate: '2026-01-10', finishDate: '2026-01-01' }), {
      ok: false,
      error: { code: 'SPRINT_DATES_REVERSED' },
    });
    assert.equal(t.sprints.rows().length, 2);
    assert.deepEqual(await new UpdateSprint(t.deps).execute({ caller: ann, id: 's2', name: 'Sprint 1' }), {
      ok: false,
      error: { code: 'SPRINT_NAME_TAKEN', name: 'Sprint 1' },
    });
    assert.deepEqual(await new UpdateSprint(t.deps).execute({ caller: ann, id: 'nope', goal: 'x' }), { ok: false, error: { code: 'SPRINT_NOT_FOUND', id: 'nope' } });
  });

  it('move all their work when deleted, open or closed, noting it in history', async () => {
    const t = setup();
    const open = await t.create('Product Backlog Item', { iterationId: 's1' });
    const done = await t.create('Task', { iterationId: 's1', state: 'Done' });
    unwrap(await new SetCapacity(t.deps).execute({ caller: ann, sprintId: 's1', ...plan('m1', 6) }));
    unwrap(await new DeleteSprint(t.deps).execute({ caller: ann, id: 's1', moveTo: 's2' }));
    assert.equal(t.item(open.id).iterationId, 's2');
    assert.equal(t.item(done.id).iterationId, 's2');
    assert.equal(t.item(open.id).history.at(-1)?.note, 'Sprint was deleted');
    assert.deepEqual(t.sprints.rows().map((s) => s.id), ['s2']);
    assert.deepEqual(t.capacities.rows(), []);
  });

  it('can send deleted work to the backlog, but not to itself or nowhere', async () => {
    const t = setup();
    const w = await t.create('Bug', { iterationId: 's1' });
    const del = new DeleteSprint(t.deps);
    assert.deepEqual(await del.execute({ caller: ann, id: 's1', moveTo: 's1' }), { ok: false, error: { code: 'SPRINT_MOVE_TO_SELF' } });
    assert.deepEqual(await del.execute({ caller: ann, id: 's1', moveTo: 's9' }), { ok: false, error: { code: 'SPRINT_NOT_FOUND', id: 's9' } });
    assert.equal(t.item(w.id).iterationId, 's1');
    unwrap(await del.execute({ caller: ann, id: 's1', moveTo: null }));
    assert.equal(t.item(w.id).iterationId, null);
  });
});

describe('capacity', () => {
  it('only plans team members, saving nothing otherwise', async () => {
    const t = setup();
    assert.deepEqual(await new SetCapacity(t.deps).execute({ caller: ann, sprintId: 's1', ...plan('ghost', 6) }), {
      ok: false,
      error: { code: 'MEMBER_NOT_FOUND', id: 'ghost' },
    });
    assert.deepEqual(await new SetCapacity(t.deps).execute({ caller: ann, sprintId: 'nope', ...plan('m1', 6) }), {
      ok: false,
      error: { code: 'SPRINT_NOT_FOUND', id: 'nope' },
    });
    assert.deepEqual(t.capacities.rows(), []);
  });

  it('copies another sprint’s plan, keeping its own days off', async () => {
    const t = setup();
    unwrap(await new SetCapacity(t.deps).execute({ caller: ann, sprintId: 's1', ...plan('m1', 4) }));
    unwrap(await new SetCapacity(t.deps).execute({ caller: ann, sprintId: 's2', ...plan('m1', 6, [{ start: '2026-01-21', end: '2026-01-21' }]) }));
    const copied = unwrap(await new CopyCapacity(t.deps).execute({ caller: ann, sprintId: 's2', fromSprintId: 's1' })).result;
    assert.deepEqual(copied.members, [{ memberId: 'm1', activities: [{ activity: 'Development', capacityPerDay: 4 }], daysOff: [{ start: '2026-01-21', end: '2026-01-21' }] }]);
    assert.deepEqual(await new CopyCapacity(t.deps).execute({ caller: ann, sprintId: 's2', fromSprintId: 'x' }), { ok: false, error: { code: 'SPRINT_NOT_FOUND', id: 'x' } });
  });
});

describe('team members', () => {
  it('are managed by administrators only', async () => {
    const t = setup();
    assert.deepEqual(await new CreateMember(t.deps).execute({ caller: bo, name: 'Eve' }), { ok: false, error: { code: 'ADMIN_ONLY', reason: 'not-admin' } });
    assert.deepEqual(await new UpdateMember(t.deps).execute({ caller: tokenCaller, id: 'm2', name: 'x' }), { ok: false, error: { code: 'ADMIN_ONLY', reason: 'token' } });
    assert.deepEqual(await new DeleteMember(t.deps).execute({ caller: bo, id: 'm2' }), { ok: false, error: { code: 'ADMIN_ONLY', reason: 'not-admin' } });
    assert.equal(t.members.rows().length, 3);
    assert.equal(t.unitOfWork.runs.length, 0);
  });

  it('get unique usernames and a colour in turn', async () => {
    const t = setup();
    const eve = unwrap(await new CreateMember(t.deps).execute({ caller: ann, name: 'Eve', username: 'eve' })).result;
    assert.equal(eve.color, '#e3008c'); // the fourth colour, after three members
    assert.deepEqual(await new UpdateMember(t.deps).execute({ caller: ann, id: 'm2', username: 'EVE' }), {
      ok: false,
      error: { code: 'USERNAME_TAKEN', username: 'EVE', takenBy: 'Eve' },
    });
  });

  it('leave: their work is unassigned and they drop out of capacity plans', async () => {
    const t = setup();
    const w = await t.create('Task', { assignedTo: 'm2' });
    unwrap(await new SetCapacity(t.deps).execute({ caller: ann, sprintId: 's1', ...plan('m2', 6) }));
    unwrap(await new DeleteMember(t.deps).execute({ caller: ann, id: 'm2' }));
    assert.equal(t.item(w.id).assignedTo, null);
    assert.equal(t.item(w.id).history.at(-1)?.note, 'Bo was removed from the team');
    assert.deepEqual(t.capacities.rows()[0]?.members, []);
    assert.ok(!t.members.rows().some((m) => m.id === 'm2'));
  });

  it('keep an administrator who can sign in', async () => {
    const t = setup();
    const w = await t.create('Task', { assignedTo: 'm1' });
    unwrap(await new UpdateMember(t.deps).execute({ caller: ann, id: 'm1', username: 'ann' }));
    const account = await t.accounts.get('m1');
    account.setAdmin(true, NOW);
    account.setPassword('hashed:correct horse', NOW, false);
    await t.accounts.save(account);
    const settings = await t.signInSettings.get();
    const on = SignInSettingsChanges.validate({ enabled: true });
    assert.ok(on.ok);
    assert.ok(settings.update(on.value, true, NOW).ok);
    await t.signInSettings.save(settings);
    assert.deepEqual(await new DeleteMember(t.deps).execute({ caller: ann, id: 'm1' }), { ok: false, error: { code: 'LAST_ADMIN' } });
    assert.deepEqual(await new UpdateMember(t.deps).execute({ caller: ann, id: 'm1', active: false }), { ok: false, error: { code: 'LAST_ADMIN' } });
    assert.equal(t.item(w.id).assignedTo, 'm1');
    assert.equal(t.members.rows()[0]?.active, true);
  });
});

describe('project settings', () => {
  it('are changed by administrators, normalised', async () => {
    const t = setup();
    assert.deepEqual(await new UpdateSettings(t.deps).execute({ caller: bo, projectName: 'x' }), { ok: false, error: { code: 'ADMIN_ONLY', reason: 'not-admin' } });
    const s = unwrap(await new UpdateSettings(t.deps).execute({ caller: ann, projectName: ' Contoso ', workingDays: [5, 1, 1] })).result;
    assert.deepEqual([s.projectName, s.workingDays], ['Contoso', [1, 5]]);
    assert.equal(t.settings.row().projectName, 'Contoso');
  });

  it('give new items without a parent their default area path', async () => {
    const t = setup();
    unwrap(await new UpdateSettings(t.deps).execute({ caller: ann, areaPaths: ['Contoso\\Web'] }));
    assert.equal((await t.create('Epic')).areaPath, 'Contoso\\Web');
  });
});
