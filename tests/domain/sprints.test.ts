import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CapacityChanges, CapacityPlan, type CapacityInput } from '#domain/sprints/capacity-plan.ts';
import { Sprint, SprintChanges, previousSprint, toSprintId, type SprintId, type SprintInput } from '#domain/sprints/sprint.ts';
import { LATER, NOW } from './fixtures.ts';

const sid = (s: string) => s as SprintId;

function changes(input: SprintInput): SprintChanges {
  const r = SprintChanges.validate(input);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function sprint(id: string, name: string, startDate: string | null = null, finishDate: string | null = null, existing: Sprint[] = []): Sprint {
  const r = Sprint.create(changes({ name, startDate, finishDate }), { id: sid(id), existing, now: NOW });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

describe('sprints', () => {
  it('are created with a trimmed name, dates and an event', () => {
    const s = sprint('s1', '  Sprint 1 ', '2026-01-05', '2026-01-16');
    assert.deepEqual(s.toSnapshot(), { id: 's1', name: 'Sprint 1', startDate: '2026-01-05', finishDate: '2026-01-16', goal: '' });
    assert.deepEqual(s.pullEvents(), [{ type: 'SprintCreated', sprintId: 's1', occurredAt: NOW }]);
  });

  it('check names, goals and dates', () => {
    assert.deepEqual(SprintChanges.validate({ name: '  ' }), { ok: false, error: { code: 'SPRINT_NAME_REQUIRED' } });
    assert.deepEqual(SprintChanges.validate({ name: 'x'.repeat(129) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'name', max: 128 } });
    assert.deepEqual(SprintChanges.validate({ goal: 'x'.repeat(4001) }), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'goal', max: 4000 } });
    assert.deepEqual(SprintChanges.validate({ startDate: '2026-02-30' }), { ok: false, error: { code: 'INVALID_DATE', field: 'startDate' } });
    const create = (input: SprintInput) => Sprint.create(changes(input), { id: sid('s'), existing: [], now: NOW });
    assert.deepEqual(create({ goal: 'x' }), { ok: false, error: { code: 'SPRINT_NAME_REQUIRED' } });
    assert.deepEqual(create({ name: 'A', startDate: '2026-01-05' }), { ok: false, error: { code: 'SPRINT_DATES_INCOMPLETE' } });
    assert.deepEqual(create({ name: 'A', startDate: '2026-01-10', finishDate: '2026-01-01' }), { ok: false, error: { code: 'SPRINT_DATES_REVERSED' } });
  });

  it('keep names unique, ignoring case', () => {
    const one = sprint('s1', 'Sprint 1');
    const two = sprint('s2', 'Sprint 2');
    assert.deepEqual(Sprint.create(changes({ name: 'sprint 1' }), { id: sid('s3'), existing: [one], now: NOW }), {
      ok: false,
      error: { code: 'SPRINT_NAME_TAKEN', name: 'sprint 1' },
    });
    assert.deepEqual(two.update(changes({ name: 'SPRINT 1' }), [one, two], LATER), { ok: false, error: { code: 'SPRINT_NAME_TAKEN', name: 'SPRINT 1' } });
    // Renaming to its own name, or changing case, is fine.
    assert.ok(one.update(changes({ name: 'SPRINT 1' }), [one, two], LATER).ok);
  });

  it('update only the given fields, keeping dates consistent', () => {
    const s = sprint('s1', 'Sprint 1', '2026-01-05', '2026-01-16');
    s.pullEvents();
    assert.deepEqual(s.update(changes({ finishDate: '2026-01-01' }), [s], LATER), { ok: false, error: { code: 'SPRINT_DATES_REVERSED' } });
    assert.deepEqual(s.update(changes({ startDate: null }), [s], LATER), { ok: false, error: { code: 'SPRINT_DATES_INCOMPLETE' } });
    assert.ok(s.update(changes({ goal: 'Ship it', startDate: null, finishDate: null }), [s], LATER).ok);
    assert.deepEqual(s.toSnapshot(), { id: 's1', name: 'Sprint 1', startDate: null, finishDate: null, goal: 'Ship it' });
    assert.deepEqual(s.pullEvents(), [{ type: 'SprintChanged', sprintId: 's1', occurredAt: LATER }]);
  });

  it('find the sprint whose capacity carries forward', () => {
    const a = sprint('a', 'A', '2026-01-05', '2026-01-16');
    const b = sprint('b', 'B', '2026-01-19', '2026-01-30');
    const undated = sprint('u', 'U');
    const next = sprint('n', 'N', '2026-02-02', '2026-02-13');
    assert.equal(previousSprint(next, [a, b, undated, next])?.id, 'b');
    assert.equal(previousSprint(a, [a, b]), undefined);
    assert.equal(previousSprint(undated, [a, b]), undefined);
  });

  it('treat an impossible id as not found', () => {
    assert.deepEqual(toSprintId(''), { ok: false, error: { code: 'SPRINT_NOT_FOUND', id: '' } });
  });
});

describe('capacity plans', () => {
  const input: CapacityInput = {
    teamDaysOff: [{ start: '2026-01-09', end: '2026-01-09' }],
    members: [{ memberId: 'm1', activities: [{ activity: 'Development', capacityPerDay: 6 }], daysOff: [{ start: '2026-01-06', end: '2026-01-07' }] }],
  };

  function valid(i: CapacityInput): CapacityChanges {
    const r = CapacityChanges.validate(i);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  }

  it('check ranges, activities and hours', () => {
    assert.deepEqual(CapacityChanges.validate({ ...input, teamDaysOff: [{ start: '2026-01-09', end: '2026-01-01' }] }), { ok: false, error: { code: 'DAYS_OFF_REVERSED' } });
    assert.deepEqual(CapacityChanges.validate({ ...input, teamDaysOff: [{ start: 'soon', end: '2026-01-01' }] }), { ok: false, error: { code: 'INVALID_DATE', field: 'daysOff' } });
    const member = input.members[0];
    assert.ok(member);
    const withActivities = (activities: { activity: string; capacityPerDay: number }[]) => CapacityChanges.validate({ ...input, members: [{ ...member, activities }] });
    assert.deepEqual(withActivities([{ activity: 'x', capacityPerDay: 25 }]), {
      ok: false,
      error: { code: 'NUMBER_OUT_OF_RANGE', field: 'capacityPerDay', min: 0, max: 24 },
    });
    assert.deepEqual(withActivities([{ activity: 'x'.repeat(65), capacityPerDay: 1 }]), { ok: false, error: { code: 'TEXT_TOO_LONG', field: 'activity', max: 64 } });
    assert.deepEqual(withActivities(Array.from({ length: 11 }, () => ({ activity: '', capacityPerDay: 1 }))), { ok: false, error: { code: 'TOO_MANY_ACTIVITIES', max: 10 } });
    assert.deepEqual(CapacityChanges.validate({ ...input, members: [member, member] }), { ok: false, error: { code: 'MEMBER_LISTED_TWICE' } });
  });

  it('are replaced whole and copied without days off', () => {
    const plan = CapacityPlan.empty(sid('s1'));
    plan.replace(valid(input), NOW);
    assert.deepEqual(plan.toSnapshot(), { sprintId: 's1', ...input });
    assert.deepEqual(plan.pullEvents(), [{ type: 'CapacityChanged', sprintId: 's1', occurredAt: NOW }]);

    const next = CapacityPlan.carriedForward(sid('s2'), plan);
    assert.deepEqual(next.toSnapshot(), { sprintId: 's2', teamDaysOff: [], members: [{ memberId: 'm1', activities: [{ activity: 'Development', capacityPerDay: 6 }], daysOff: [] }] });
    assert.deepEqual(CapacityPlan.carriedForward(sid('s3'), undefined).toSnapshot(), { sprintId: 's3', teamDaysOff: [], members: [] });
  });

  it('copy another plan keeping their own days off', () => {
    const from = CapacityPlan.empty(sid('s1'));
    from.replace(valid({ teamDaysOff: [], members: [{ memberId: 'm1', activities: [{ activity: 'Testing', capacityPerDay: 2 }], daysOff: [] }] }), NOW);
    const to = CapacityPlan.empty(sid('s2'));
    to.replace(valid(input), NOW);
    to.copyFrom(from, LATER);
    assert.deepEqual(to.toSnapshot().members, [{ memberId: 'm1', activities: [{ activity: 'Testing', capacityPerDay: 2 }], daysOff: [{ start: '2026-01-06', end: '2026-01-07' }] }]);
  });

  it('drop members who left', () => {
    const plan = CapacityPlan.empty(sid('s1'));
    plan.replace(valid(input), NOW);
    assert.equal(plan.removeMember('m9', LATER), false);
    assert.equal(plan.removeMember('m1', LATER), true);
    assert.deepEqual(plan.toSnapshot().members, []);
  });
});
