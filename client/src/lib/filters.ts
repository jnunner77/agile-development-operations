import type { WorkItem } from '../../../shared/types';

export interface Filters {
  keyword: string;
  types: string[];
  states: string[];
  /** Member ids; '' means unassigned. */
  assignedTo: string[];
  tags: string[];
  /** Sprint ids; '' means the product backlog. */
  iterations: string[];
}

export const EMPTY_FILTERS: Filters = { keyword: '', types: [], states: [], assignedTo: [], tags: [], iterations: [] };

export function isFiltering(f: Filters) {
  return !!(f.keyword.trim() || f.types.length || f.states.length || f.assignedTo.length || f.tags.length || f.iterations.length);
}

export function matchesFilters(item: WorkItem, f: Filters): boolean {
  const kw = f.keyword.trim().toLowerCase();
  if (kw) {
    const hay = `${item.id} ${item.title} ${item.tags.join(' ')}`.toLowerCase();
    if (!kw.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  if (f.types.length && !f.types.includes(item.type)) return false;
  if (f.states.length && !f.states.includes(item.state)) return false;
  if (f.assignedTo.length && !f.assignedTo.includes(item.assignedTo ?? '')) return false;
  if (f.iterations.length && !f.iterations.includes(item.iterationId ?? '')) return false;
  if (f.tags.length) {
    const lower = item.tags.map((t) => t.toLowerCase());
    if (!f.tags.some((t) => lower.includes(t.toLowerCase()))) return false;
  }
  return true;
}
