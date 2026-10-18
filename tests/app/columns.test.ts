import { describe, it } from 'node:test';
import { expect } from './support/expect.ts';
import { savedColumns, shownColumns, toggleColumn, type ColumnSpec } from '../../client/src/lib/columns.ts';

const columns: ColumnSpec[] = [
  { key: 'order', label: 'Order' },
  { key: 'title', label: 'Title', required: true },
  { key: 'state', label: 'State' },
  { key: 'priority', label: 'Priority' },
  { key: 'tags', label: 'Tags' },
];
const keys = (list: readonly ColumnSpec[]) => list.map((c) => c.key);

describe('grid column choice', () => {
  it('shows the defaults until a choice is saved, in the grid order, always with required columns', () => {
    expect(keys(shownColumns(columns, null, ['tags', 'order']))).toEqual(['order', 'title', 'tags']);
  });

  it('shows a saved choice in the grid order and ignores columns the grid no longer has', () => {
    expect(keys(shownColumns(columns, ['priority', 'gone', 'state'], ['order']))).toEqual(['title', 'state', 'priority']);
    // An empty choice still leaves the required columns.
    expect(keys(shownColumns(columns, [], ['order']))).toEqual(['title']);
  });

  it('toggles one column, never hiding a required one', () => {
    const shown = shownColumns(columns, null, ['order', 'state']);
    expect(toggleColumn(columns, shown, 'priority')).toEqual(['order', 'state', 'priority']);
    expect(toggleColumn(columns, shown, 'order')).toEqual(['state']);
    expect(toggleColumn(columns, shown, 'title')).toEqual(['order', 'state']);
  });

  it('reads back only a list of column names from browser storage', () => {
    expect(savedColumns(['state', 'tags'])).toEqual(['state', 'tags']);
    expect(savedColumns(null)).toBe(null);
    expect(savedColumns('state')).toBe(null);
    expect(savedColumns(['state', 3])).toBe(null);
  });
});
