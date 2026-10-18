/** A column a grid can show. A `required` column (e.g. Title) can't be hidden. */
export interface ColumnSpec<K extends string = string> {
  key: K;
  label: string;
  required?: boolean;
}

/**
 * The columns to show, in the grid's own order: the person's saved choice when there is one,
 * else the defaults. Saved keys the grid no longer has are ignored; required columns always show.
 */
export function shownColumns<C extends ColumnSpec>(columns: readonly C[], saved: readonly string[] | null, defaults: readonly string[]): C[] {
  const pick = new Set(saved ?? defaults);
  return columns.filter((c) => c.required || pick.has(c.key));
}

/** The choice to save after showing or hiding one column. Required columns can't be hidden. */
export function toggleColumn(columns: readonly ColumnSpec[], shown: readonly ColumnSpec[], key: string): string[] {
  const keys = new Set(shown.map((c) => c.key));
  if (keys.has(key)) keys.delete(key);
  else keys.add(key);
  return columns.filter((c) => !c.required && keys.has(c.key)).map((c) => c.key);
}

/** A saved choice read back from browser storage, or null when there is none (or it's not a list of names). */
export function savedColumns(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null;
}
