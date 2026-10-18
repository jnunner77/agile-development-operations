import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { savedColumns, shownColumns, toggleColumn, type ColumnSpec } from '../lib/columns';
import { useIsPhone, useLocalState } from '../lib/hooks';
import { useStore } from '../store';
import { Icon } from './Icon';

/**
 * Which of a grid's columns the current user shows, remembered per browser under `key`.
 * Until they choose, phones get `defaults.phone` and bigger screens `defaults.wide`.
 */
export function useColumnChoice<C extends ColumnSpec>(key: string, columns: readonly C[], defaults: { wide: readonly string[]; phone: readonly string[] }) {
  const userId = useStore((s) => s.currentUserId);
  const phone = useIsPhone();
  const [stored, setStored] = useLocalState<{ columns: string[] | null }>(`${key}.columns.${userId ?? 'anonymous'}`, { columns: null });
  const saved = savedColumns(stored.columns);
  const shown = shownColumns(columns, saved, phone ? defaults.phone : defaults.wide);
  return {
    shown,
    isDefault: saved === null,
    toggle: (column: string) => setStored({ columns: toggleColumn(columns, shown, column) }),
    reset: () => setStored({ columns: null }),
  };
}

/** A "Column options" button whose dropdown lists the grid's columns as checkboxes. It stays open while you pick. */
export function ColumnPicker({
  columns,
  choice,
}: {
  columns: readonly ColumnSpec[];
  choice: { shown: readonly ColumnSpec[]; isDefault: boolean; toggle: (key: string) => void; reset: () => void };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const shown = new Set(choice.shown.map((c) => c.key));

  // Keep the list above the bottom of the screen (or the phone's bottom navigation); it scrolls inside.
  useLayoutEffect(() => {
    const popup = ref.current?.querySelector<HTMLElement>('.column-picker-popup');
    if (!popup) return;
    const nav = document.querySelector('.bottomnav')?.getBoundingClientRect();
    const bottom = nav && nav.height > 0 ? nav.top : window.innerHeight;
    popup.style.maxHeight = `${Math.max(160, Math.min(440, bottom - popup.getBoundingClientRect().top - 8))}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLInputElement>('.column-picker-popup input:not(:disabled)')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="column-picker" ref={ref}>
      <button
        ref={button}
        className={`btn btn-ghost ${open ? 'active' : ''}`}
        aria-label="Column options"
        title="Column options"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="list" size={14} /> <span className="btn-label">Column options</span> <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="column-picker-popup" role="group" aria-label="Columns">
          <div className="column-picker-head">Columns</div>
          {columns.map((c) => (
            <label key={c.key} className="check-row">
              <input type="checkbox" checked={c.required || shown.has(c.key)} disabled={c.required} onChange={() => choice.toggle(c.key)} />
              <span>{c.label}</span>
            </label>
          ))}
          <div className="menu-divider" />
          <button className="link-btn small" disabled={choice.isDefault} onClick={choice.reset}>
            Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}
