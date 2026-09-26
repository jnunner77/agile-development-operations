import { formatShortDate } from '../../../shared/dates';
import type { Member, Sprint, WorkItem } from '../../../shared/types';

export const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  state: 'State',
  reason: 'Reason',
  assignedTo: 'Assigned To',
  areaPath: 'Area Path',
  iterationId: 'Iteration',
  parentId: 'Parent',
  priority: 'Priority',
  effort: 'Effort',
  businessValue: 'Business Value',
  timeCriticality: 'Time Criticality',
  valueArea: 'Value Area',
  risk: 'Risk',
  severity: 'Severity',
  activity: 'Activity',
  blocked: 'Blocked',
  originalEstimate: 'Original Estimate',
  remainingWork: 'Remaining Work',
  completedWork: 'Completed Work',
  startDate: 'Start Date',
  targetDate: 'Target Date',
  dueDate: 'Due Date',
  description: 'Description',
  acceptanceCriteria: 'Acceptance Criteria',
  reproSteps: 'Repro Steps',
  systemInfo: 'System Info',
  foundInBuild: 'Found In Build',
  integratedInBuild: 'Integrated In Build',
  tags: 'Tags',
};

export const HTML_FIELDS = new Set(['description', 'acceptanceCriteria', 'reproSteps', 'systemInfo']);

export function formatHours(h: number | null | undefined): string {
  if (h == null) return '';
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n == null) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function formatDateTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function timeAgo(ts: string, now = Date.now()): string {
  const secs = Math.round((now - Date.parse(ts)) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').trim();
}

interface Lookup {
  members: Member[];
  sprints: Sprint[];
  itemsById: Map<number, WorkItem>;
}

/** Human-readable value for the history view. */
export function formatFieldValue(field: string, value: unknown, lookup: Lookup): string {
  if (value === null || value === undefined || value === '') return '';
  switch (field) {
    case 'assignedTo':
      return lookup.members.find((m) => m.id === value)?.name ?? 'Former team member';
    case 'iterationId':
      return lookup.sprints.find((s) => s.id === value)?.name ?? 'Deleted sprint';
    case 'parentId': {
      const p = lookup.itemsById.get(value as number);
      return p ? `#${p.id} ${p.title}` : `#${value}`;
    }
    case 'tags':
      return Array.isArray(value) ? value.join('; ') : String(value);
    case 'blocked':
      return value ? 'Yes' : 'No';
    case 'startDate':
    case 'targetDate':
    case 'dueDate':
      return formatShortDate(value as string);
    case 'originalEstimate':
    case 'remainingWork':
    case 'completedWork':
      return formatHours(value as number);
    default:
      if (HTML_FIELDS.has(field)) return stripHtml(String(value));
      return String(value);
  }
}

export function iterationName(sprints: Sprint[], id: string | null, projectName: string) {
  if (!id) return projectName || 'Backlog';
  return sprints.find((s) => s.id === id)?.name ?? 'Unknown sprint';
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}
