import type { DateRange, DateString } from './types';

// All calendar math is done on YYYY-MM-DD strings interpreted as UTC midnight,
// so results never depend on the viewer's time zone.

const DAY_MS = 86_400_000;

export function toUtcMs(date: DateString): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function fromUtcMs(ms: number): DateString {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: DateString, days: number): DateString {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

export function diffDays(a: DateString, b: DateString): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function dayOfWeek(date: DateString): number {
  return new Date(toUtcMs(date)).getUTCDay();
}

/** Today's date in the local time zone. */
export function todayLocal(now: Date = new Date()): DateString {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function isValidDate(value: unknown): value is DateString {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return fromUtcMs(toUtcMs(value)) === value;
}

/** Inclusive list of every calendar day between start and end. */
export function eachDay(start: DateString, end: DateString): DateString[] {
  const days: DateString[] = [];
  if (toUtcMs(end) < toUtcMs(start)) return days;
  for (let ms = toUtcMs(start); ms <= toUtcMs(end); ms += DAY_MS) days.push(fromUtcMs(ms));
  return days;
}

export function inRange(date: DateString, range: DateRange): boolean {
  return date >= range.start && date <= range.end;
}

export function inAnyRange(date: DateString, ranges: DateRange[]): boolean {
  return ranges.some((r) => inRange(date, r));
}

export function isWorkingDay(date: DateString, workingDays: number[]): boolean {
  return workingDays.includes(dayOfWeek(date));
}

/** Working days in [start, end] that are not covered by any of the given days-off ranges. */
export function workingDaysBetween(
  start: DateString,
  end: DateString,
  workingDays: number[],
  daysOff: DateRange[] = [],
): DateString[] {
  return eachDay(start, end).filter((d) => isWorkingDay(d, workingDays) && !inAnyRange(d, daysOff));
}

/** Count working days covered by the given ranges, clipped to [start, end]. */
export function countDaysOff(
  ranges: DateRange[],
  start: DateString,
  end: DateString,
  workingDays: number[],
): number {
  const seen = new Set<DateString>();
  for (const r of ranges) {
    const s = r.start > start ? r.start : start;
    const e = r.end < end ? r.end : end;
    for (const d of eachDay(s, e)) if (isWorkingDay(d, workingDays)) seen.add(d);
  }
  return seen.size;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatShortDate(date: DateString | null | undefined): string {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function formatDayMonth(date: DateString): string {
  const [, m, d] = date.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

export function formatRange(range: DateRange): string {
  if (range.start === range.end) return formatShortDate(range.start);
  return `${formatDayMonth(range.start)} - ${formatShortDate(range.end)}`;
}
