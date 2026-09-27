import { describe, expect, it } from 'vitest';
import { computeBurndown, fieldValueAt } from '../shared/burndown';
import { addDays, countDaysOff, isValidDate, workingDaysBetween } from '../shared/dates';
import { computeCapacity, computeSprintWork, defaultSprint, nextSprint, suggestNextSprint } from '../shared/sprints';
import type { Sprint, SprintCapacity, WorkItem } from '../shared/types';
import { blankWorkItem } from '../server/schema';

const WEEKDAYS = [1, 2, 3, 4, 5];
const sprint: Sprint = { id: 's1', name: 'Sprint 1', startDate: '2026-01-05', finishDate: '2026-01-16', goal: '' };

describe('dates', () => {
  it('counts working days and days off', () => {
    expect(workingDaysBetween('2026-01-05', '2026-01-16', WEEKDAYS)).toHaveLength(10);
    expect(workingDaysBetween('2026-01-05', '2026-01-16', WEEKDAYS, [{ start: '2026-01-09', end: '2026-01-12' }])).toHaveLength(8);
    // Weekend days inside a range don't count, and overlapping ranges count once.
    expect(countDaysOff([{ start: '2026-01-09', end: '2026-01-12' }, { start: '2026-01-12', end: '2026-01-12' }], '2026-01-05', '2026-01-16', WEEKDAYS)).toBe(2);
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2028-02-29')).toBe(true);
  });
});

describe('capacity', () => {
  const cap: SprintCapacity = {
    sprintId: 's1',
    teamDaysOff: [{ start: '2026-01-16', end: '2026-01-16' }],
    members: [
      { memberId: 'a', activities: [{ activity: 'Development', capacityPerDay: 6 }], daysOff: [{ start: '2026-01-05', end: '2026-01-06' }] },
      { memberId: 'b', activities: [{ activity: 'Development', capacityPerDay: 2 }, { activity: 'Testing', capacityPerDay: 4 }], daysOff: [] },
    ],
  };

  it('computes total and remaining capacity with personal and team days off', () => {
    const before = computeCapacity(sprint, cap, WEEKDAYS, '2026-01-01');
    expect(before.workingDays).toBe(9);
    expect(before.teamDaysOff).toBe(1);
    expect(before.members[0]).toMatchObject({ totalCapacity: 6 * 7, daysOff: 3 });
    expect(before.members[1].totalCapacity).toBe(6 * 9);
    expect(before.remainingCapacity).toBe(before.totalCapacity);
    expect(before.byActivity).toEqual({ Development: 6 * 7 + 2 * 9, Testing: 4 * 9 });

    // From Monday of week two: 4 working days left (Friday is a team day off).
    const mid = computeCapacity(sprint, cap, WEEKDAYS, '2026-01-12');
    expect(mid.remainingWorkingDays).toBe(4);
    expect(mid.remainingCapacity).toBe(6 * 4 + 6 * 4);
    expect(computeCapacity(sprint, cap, WEEKDAYS, '2026-02-01').remainingCapacity).toBe(0);
  });

  it('sums remaining work on leaf items only', () => {
    const items: WorkItem[] = [
      blankWorkItem({ id: 1, type: 'Product Backlog Item', title: 'p', iterationId: 's1', remainingWork: 50 }),
      blankWorkItem({ id: 2, type: 'Task', title: 't', iterationId: 's1', parentId: 1, remainingWork: 5, assignedTo: 'a', activity: 'Development' }),
      blankWorkItem({ id: 3, type: 'Task', title: 't', iterationId: 's1', parentId: 1, remainingWork: 3, state: 'Done' }),
      blankWorkItem({ id: 4, type: 'Bug', title: 'b', iterationId: 's1', remainingWork: 2 }),
      blankWorkItem({ id: 5, type: 'Task', title: 'other sprint', iterationId: 's2', remainingWork: 9 }),
    ];
    const work = computeSprintWork(items, 's1');
    expect(work.total).toBe(7);
    expect(work.byMember).toEqual({ a: 5, '': 2 });
    expect(work.byActivity).toEqual({ Development: 5, Unassigned: 2 });
  });
});

describe('sprint helpers', () => {
  it('picks the current sprint and suggests the next one', () => {
    const s2: Sprint = { id: 's2', name: 'Sprint 2', startDate: '2026-01-19', finishDate: '2026-01-30', goal: '' };
    expect(defaultSprint([sprint, s2], '2026-01-20')?.id).toBe('s2');
    expect(defaultSprint([sprint, s2], '2026-01-17')?.id).toBe('s2');
    expect(defaultSprint([sprint, s2], '2026-03-01')?.id).toBe('s2');
    expect(suggestNextSprint([sprint, s2], '2026-01-20')).toEqual({ name: 'Sprint 3', startDate: '2026-02-02', finishDate: '2026-02-13' });
    expect(suggestNextSprint([], '2026-01-07')).toEqual({ name: 'Sprint 1', startDate: '2026-01-12', finishDate: '2026-01-23' });
  });
});

describe('nextSprint', () => {
  it('finds the following sprint by date, with undated sprints last', () => {
    const s2: Sprint = { ...sprint, id: 's2', name: 'Sprint 2', startDate: '2026-01-19', finishDate: '2026-01-30' };
    const later: Sprint = { ...sprint, id: 's9', name: 'Someday', startDate: null, finishDate: null };
    const list = [later, s2, sprint]; // deliberately out of order
    expect(nextSprint(list, sprint)?.id).toBe('s2');
    expect(nextSprint(list, s2)?.id).toBe('s9');
    expect(nextSprint(list, later)).toBeUndefined();
  });
});

describe('burndown', () => {
  it('reconstructs historic values from the change log', () => {
    const task = blankWorkItem({
      id: 1,
      type: 'Task',
      title: 't',
      iterationId: 's1',
      remainingWork: 2,
      createdAt: '2026-01-05T08:00:00.000Z',
      history: [
        { id: 'a', changedBy: 'x', changedAt: '2026-01-06T10:00:00.000Z', changes: [{ field: 'remainingWork', oldValue: 10, newValue: 6 }] },
        { id: 'b', changedBy: 'x', changedAt: '2026-01-08T10:00:00.000Z', changes: [{ field: 'remainingWork', oldValue: 6, newValue: 2 }] },
      ],
    });
    expect(fieldValueAt(task, 'remainingWork', '2026-01-05T23:59:59Z')).toBe(10);
    expect(fieldValueAt(task, 'remainingWork', '2026-01-07T23:59:59Z')).toBe(6);
    const late = blankWorkItem({ id: 2, type: 'Task', title: 'added mid-sprint', iterationId: 's1', remainingWork: 4, createdAt: '2026-01-07T09:00:00.000Z' });
    const points = computeBurndown(sprint, [task, late], WEEKDAYS, '2026-01-08');
    expect(points).toHaveLength(10);
    expect(points.slice(0, 4).map((p) => p.remaining)).toEqual([10, 6, 10, 6]);
    expect(points[4].remaining).toBeNull();
    expect(points[0].ideal).toBe(10);
    expect(points[9].ideal).toBe(0);
  });
});
