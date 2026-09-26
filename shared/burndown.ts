import { eachDay, isWorkingDay } from './dates';
import type { DateString, Sprint, WorkItem } from './types';

/**
 * Reconstruct the value a field had at the end of a given timestamp by walking the
 * item's history backwards: the oldest change made after `at` tells us the value
 * before it; otherwise the current value is still in effect.
 */
export function fieldValueAt<K extends keyof WorkItem>(item: WorkItem, field: K, at: string): WorkItem[K] {
  let value: unknown = item[field];
  for (let i = item.history.length - 1; i >= 0; i--) {
    const entry = item.history[i];
    if (entry.changedAt <= at) break;
    const change = entry.changes.find((c) => c.field === field);
    if (change) value = change.oldValue;
  }
  return value as WorkItem[K];
}

export interface BurndownPoint {
  date: DateString;
  remaining: number | null;
  ideal: number;
  completedEffort: number | null;
  totalEffort: number | null;
}

/** Remaining-work burndown for a sprint, reconstructed from work item history. */
export function computeBurndown(
  sprint: Sprint,
  items: WorkItem[],
  workingDays: number[],
  today: DateString,
): BurndownPoint[] {
  if (!sprint.startDate || !sprint.finishDate) return [];
  const days = eachDay(sprint.startDate, sprint.finishDate).filter((d) => isWorkingDay(d, workingDays));
  if (days.length === 0) return [];

  const snapshot = (day: DateString) => {
    const at = `${day}T23:59:59.999Z`;
    const live = items.filter((i) => i.createdAt <= at);
    const inSprint = live.filter((i) => fieldValueAt(i, 'iterationId', at) === sprint.id);
    const states = new Map(inSprint.map((i) => [i.id, fieldValueAt(i, 'state', at)]));
    const parents = new Set(inSprint.map((i) => fieldValueAt(i, 'parentId', at)).filter((p) => p != null));
    let remaining = 0;
    let totalEffort = 0;
    let completedEffort = 0;
    for (const item of inSprint) {
      const state = states.get(item.id);
      if (state === 'Removed') continue;
      if (item.type === 'Product Backlog Item' || item.type === 'Bug') {
        const effort = Number(fieldValueAt(item, 'effort', at) ?? 0);
        totalEffort += effort;
        if (state === 'Done') completedEffort += effort;
      }
      if (parents.has(item.id) || state === 'Done') continue;
      remaining += Number(fieldValueAt(item, 'remainingWork', at) ?? 0);
    }
    return { remaining, totalEffort, completedEffort };
  };

  const first = snapshot(days[0]);
  const start = first.remaining;
  return days.map((date, idx) => {
    const ideal = days.length === 1 ? 0 : start - (start * idx) / (days.length - 1);
    if (date > today) return { date, remaining: null, ideal, completedEffort: null, totalEffort: null };
    const s = idx === 0 ? first : snapshot(date);
    return { date, remaining: s.remaining, ideal, completedEffort: s.completedEffort, totalEffort: s.totalEffort };
  });
}

export interface VelocityPoint {
  sprintId: string;
  name: string;
  completed: number;
  incomplete: number;
}

/** Effort completed per sprint for backlog items currently assigned to that sprint. */
export function computeVelocity(sprints: Sprint[], items: WorkItem[]): VelocityPoint[] {
  return sprints.map((s) => {
    let completed = 0;
    let incomplete = 0;
    for (const i of items) {
      if (i.iterationId !== s.id) continue;
      if (i.type !== 'Product Backlog Item' && i.type !== 'Bug') continue;
      if (i.state === 'Removed') continue;
      if (i.state === 'Done') completed += i.effort ?? 0;
      else incomplete += i.effort ?? 0;
    }
    return { sprintId: s.id, name: s.name, completed, incomplete };
  });
}
