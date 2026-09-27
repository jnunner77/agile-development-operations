import { addDays, countDaysOff, dayOfWeek, diffDays, workingDaysBetween } from './dates';
import type { DateString, Sprint, SprintCapacity, WorkItem, Member } from './types';

export type SprintTimeframe = 'past' | 'current' | 'future' | 'unscheduled';

export function sprintTimeframe(sprint: Sprint, today: DateString): SprintTimeframe {
  if (!sprint.startDate || !sprint.finishDate) return 'unscheduled';
  if (today < sprint.startDate) return 'future';
  if (today > sprint.finishDate) return 'past';
  return 'current';
}

export function sortSprints(sprints: Sprint[]): Sprint[] {
  return [...sprints].sort((a, b) => {
    if (a.startDate && b.startDate) return a.startDate.localeCompare(b.startDate) || a.name.localeCompare(b.name);
    if (a.startDate) return -1;
    if (b.startDate) return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
}

/** The sprint that follows `sprint` in date order (undated sprints come last), if any. */
export function nextSprint(sprints: Sprint[], sprint: Sprint): Sprint | undefined {
  const sorted = sortSprints(sprints);
  const idx = sorted.findIndex((s) => s.id === sprint.id);
  return idx >= 0 ? sorted[idx + 1] : undefined;
}

export function currentSprint(sprints: Sprint[], today: DateString): Sprint | undefined {
  return sortSprints(sprints).find((s) => sprintTimeframe(s, today) === 'current');
}

/** Sprint shown by default: the current one, else the next future one, else the latest. */
export function defaultSprint(sprints: Sprint[], today: DateString): Sprint | undefined {
  const sorted = sortSprints(sprints);
  return (
    sorted.find((s) => sprintTimeframe(s, today) === 'current') ??
    sorted.find((s) => sprintTimeframe(s, today) === 'future') ??
    sorted[sorted.length - 1]
  );
}

/** Proposed name and dates for the sprint that follows the latest one. */
export function suggestNextSprint(sprints: Sprint[], today: DateString): Omit<Sprint, 'id' | 'goal'> {
  const dated = sortSprints(sprints).filter((s) => s.startDate && s.finishDate);
  const last = dated[dated.length - 1];
  const nums = sprints.map((s) => Number(/(\d+)\s*$/.exec(s.name)?.[1] ?? 0));
  const nextNum = Math.max(0, ...nums) + 1;
  if (!last) {
    // Start on the next Monday, two weeks long (Monday to the following Friday).
    const start = addDays(today, (8 - dayOfWeek(today)) % 7 || 7);
    return { name: `Sprint ${nextNum}`, startDate: start, finishDate: addDays(start, 11) };
  }
  const length = diffDays(last.startDate!, last.finishDate!);
  // Friday finish -> Monday start is the common case; otherwise start the next day.
  const start = addDays(last.finishDate!, dayOfWeek(last.finishDate!) === 5 ? 3 : 1);
  return { name: `Sprint ${nextNum}`, startDate: start, finishDate: addDays(start, length) };
}

export interface MemberCapacitySummary {
  memberId: string;
  capacityPerDay: number;
  /** Working days in the sprint (whole sprint). */
  sprintDays: number;
  /** Personal + team days off within the whole sprint. */
  daysOff: number;
  /** Hours for the whole sprint. */
  totalCapacity: number;
  /** Hours from today (or the sprint start) to the end of the sprint. */
  remainingCapacity: number;
  byActivity: Record<string, number>;
}

export interface CapacitySummary {
  workingDays: number;
  remainingWorkingDays: number;
  teamDaysOff: number;
  totalCapacity: number;
  remainingCapacity: number;
  members: MemberCapacitySummary[];
  byActivity: Record<string, number>;
}

/** Capacity math used by the capacity page and the work details panel. */
export function computeCapacity(
  sprint: Sprint,
  capacity: SprintCapacity | undefined,
  workingDays: number[],
  today: DateString,
): CapacitySummary {
  const empty: CapacitySummary = {
    workingDays: 0,
    remainingWorkingDays: 0,
    teamDaysOff: 0,
    totalCapacity: 0,
    remainingCapacity: 0,
    members: [],
    byActivity: {},
  };
  if (!sprint.startDate || !sprint.finishDate) return empty;
  const { startDate, finishDate } = sprint;
  const teamOff = capacity?.teamDaysOff ?? [];
  const remainingStart = today > startDate ? today : startDate;
  const allDays = workingDaysBetween(startDate, finishDate, workingDays);
  const teamDays = workingDaysBetween(startDate, finishDate, workingDays, teamOff);
  const teamRemainingDays = remainingStart > finishDate ? [] : workingDaysBetween(remainingStart, finishDate, workingDays, teamOff);

  const summary: CapacitySummary = {
    ...empty,
    workingDays: teamDays.length,
    remainingWorkingDays: teamRemainingDays.length,
    teamDaysOff: allDays.length - teamDays.length,
  };

  for (const mc of capacity?.members ?? []) {
    const off = [...teamOff, ...mc.daysOff];
    const days = workingDaysBetween(startDate, finishDate, workingDays, off).length;
    const remainingDays = remainingStart > finishDate ? 0 : workingDaysBetween(remainingStart, finishDate, workingDays, off).length;
    const perDay = mc.activities.reduce((sum, a) => sum + (a.capacityPerDay || 0), 0);
    const byActivity: Record<string, number> = {};
    for (const a of mc.activities) {
      if (!a.capacityPerDay) continue;
      const key = a.activity || 'Unassigned';
      byActivity[key] = (byActivity[key] ?? 0) + a.capacityPerDay * remainingDays;
      summary.byActivity[key] = (summary.byActivity[key] ?? 0) + a.capacityPerDay * remainingDays;
    }
    const m: MemberCapacitySummary = {
      memberId: mc.memberId,
      capacityPerDay: perDay,
      sprintDays: allDays.length,
      daysOff: countDaysOff(off, startDate, finishDate, workingDays),
      totalCapacity: perDay * days,
      remainingCapacity: perDay * remainingDays,
      byActivity,
    };
    summary.members.push(m);
    summary.totalCapacity += m.totalCapacity;
    summary.remainingCapacity += m.remainingCapacity;
  }
  return summary;
}

export interface WorkSummary {
  total: number;
  byMember: Record<string, number>;
  byActivity: Record<string, number>;
}

/**
 * Remaining work in a sprint. Leaf items (items with no children in the same sprint)
 * contribute their Remaining Work so hours are never double counted between a
 * backlog item and its tasks.
 */
export function computeSprintWork(items: WorkItem[], sprintId: string): WorkSummary {
  const inSprint = items.filter((i) => i.iterationId === sprintId && i.state !== 'Removed');
  const parents = new Set(inSprint.map((i) => i.parentId).filter((id): id is number => id != null));
  const summary: WorkSummary = { total: 0, byMember: {}, byActivity: {} };
  for (const item of inSprint) {
    if (parents.has(item.id)) continue;
    if (item.state === 'Done') continue;
    const hours = item.remainingWork ?? 0;
    if (!hours) continue;
    summary.total += hours;
    const who = item.assignedTo ?? '';
    summary.byMember[who] = (summary.byMember[who] ?? 0) + hours;
    const act = item.activity || 'Unassigned';
    summary.byActivity[act] = (summary.byActivity[act] ?? 0) + hours;
  }
  return summary;
}

export function memberName(members: Member[], id: string | null | undefined): string {
  if (!id) return 'Unassigned';
  return members.find((m) => m.id === id)?.name ?? 'Unknown user';
}
