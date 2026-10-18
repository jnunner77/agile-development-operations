import type { ReactNode } from 'react';
import { formatShortDate, todayLocal } from '#domain/dates.ts';
import type { WorkItem } from '#domain/types.ts';
import { Person, StateBadge, Tags } from '../../components/common';
import type { ColumnSpec } from '../../lib/columns';
import { formatHours, formatNumber } from '../../lib/format';
import type { rollup } from '../../lib/hooks';

/** What a cell may need besides the item itself. */
export interface CellContext {
  /** 1-based backlog order of a top-level row; null for tasks under it. */
  order: number | null;
  /** Hours rolled up from the item's tasks. */
  rolled: ReturnType<typeof rollup>;
  itemsById: Map<number, WorkItem>;
}

export interface BacklogColumn extends ColumnSpec {
  /** Class for both the header and the cells (e.g. `col-order`). */
  className?: string;
  /** Extra class for the cells only (e.g. `num`). */
  cellClass?: string;
  cell: (w: WorkItem, ctx: CellContext) => ReactNode;
}

/** A long value cut short with an ellipsis; the full text shows on hover. */
const clip = (text: string) =>
  text ? (
    <span className="cell-clip" title={text}>
      {text}
    </span>
  ) : null;

/** A stored timestamp as a date in the viewer's time zone. */
const localDate = (ts: string | null) => (ts ? formatShortDate(todayLocal(new Date(ts))) : '');

/** Hours: rolled up from the tasks for an item that has them, else the item's own value. */
const hours = (own: number | null, rolledUp: number, ctx: CellContext) => formatHours(ctx.rolled.hasChildren ? rolledUp : own);

/**
 * Every column the sprint backlog can show, in display order. The Title cell is drawn by the
 * backlog itself (expander, icon, add-task button), so its `cell` is never used.
 */
export const SPRINT_BACKLOG_COLUMNS: readonly BacklogColumn[] = [
  { key: 'order', label: 'Order', className: 'col-order', cellClass: 'muted', cell: (_, ctx) => ctx.order ?? '' },
  { key: 'id', label: 'ID', cellClass: 'num muted', cell: (w) => w.id },
  { key: 'type', label: 'Work Item Type', className: 'col-work-item-type', cell: (w) => w.type },
  { key: 'title', label: 'Title', required: true, className: 'col-title', cell: () => null },
  { key: 'state', label: 'State', cell: (w) => <StateBadge type={w.type} state={w.state} /> },
  { key: 'reason', label: 'Reason', cell: (w) => clip(w.reason) },
  { key: 'assignedTo', label: 'Assigned To', cellClass: 'col-person', cell: (w) => <Person id={w.assignedTo} /> },
  { key: 'priority', label: 'Priority', cellClass: 'num', cell: (w) => formatNumber(w.priority) },
  { key: 'effort', label: 'Effort', cellClass: 'num', cell: (w) => formatNumber(w.effort) },
  { key: 'businessValue', label: 'Business Value', cellClass: 'num', cell: (w) => formatNumber(w.businessValue) },
  { key: 'timeCriticality', label: 'Time Criticality', cellClass: 'num', cell: (w) => formatNumber(w.timeCriticality) },
  { key: 'originalEstimate', label: 'Original Estimate', cellClass: 'num', cell: (w, ctx) => hours(w.originalEstimate, ctx.rolled.original, ctx) },
  { key: 'remainingWork', label: 'Remaining Work', cellClass: 'num', cell: (w, ctx) => hours(w.remainingWork, ctx.rolled.remaining, ctx) },
  { key: 'completedWork', label: 'Completed Work', cellClass: 'num', cell: (w, ctx) => hours(w.completedWork, ctx.rolled.completed, ctx) },
  { key: 'activity', label: 'Activity', cell: (w) => w.activity ?? '' },
  { key: 'valueArea', label: 'Value Area', cell: (w) => w.valueArea ?? '' },
  { key: 'risk', label: 'Risk', cell: (w) => w.risk ?? '' },
  { key: 'severity', label: 'Severity', cell: (w) => w.severity ?? '' },
  { key: 'startDate', label: 'Start Date', cell: (w) => formatShortDate(w.startDate) },
  { key: 'targetDate', label: 'Target Date', cell: (w) => formatShortDate(w.targetDate) },
  { key: 'dueDate', label: 'Due Date', cell: (w) => formatShortDate(w.dueDate) },
  { key: 'parent', label: 'Parent', cell: (w, ctx) => clip((w.parentId != null && ctx.itemsById.get(w.parentId)?.title) || '') },
  { key: 'areaPath', label: 'Area Path', cell: (w) => clip(w.areaPath) },
  { key: 'tags', label: 'Tags', cell: (w) => <Tags tags={w.tags} max={2} /> },
  { key: 'createdAt', label: 'Created Date', cell: (w) => localDate(w.createdAt) },
  { key: 'changedAt', label: 'Changed Date', cell: (w) => localDate(w.changedAt) },
];

/** Shown until someone picks their own columns. */
export const SPRINT_BACKLOG_DEFAULTS = {
  wide: ['order', 'state', 'assignedTo', 'effort', 'remainingWork', 'activity', 'tags'],
  phone: ['state', 'assignedTo'],
};
