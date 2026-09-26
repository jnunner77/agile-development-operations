import { useEffect, useMemo, useRef, useState } from 'react';
import { formatRange, isValidDate } from '../../../shared/dates';
import type { WorkItemType } from '../../../shared/process';
import type { DateRange, WorkItem } from '../../../shared/types';
import { useStore } from '../store';
import { Avatar, StateBadge } from './common';
import { Icon, TypeIcon } from './Icon';

export function TagsInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const items = useStore((s) => s.workItems);
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const w of items) for (const t of w.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);
  const suggestions = text
    ? allTags.filter((t) => t.toLowerCase().includes(text.toLowerCase()) && !value.some((v) => v.toLowerCase() === t.toLowerCase())).slice(0, 8)
    : [];

  const add = (tag: string) => {
    const t = tag.trim().replace(/;/g, '');
    if (t && !value.some((v) => v.toLowerCase() === t.toLowerCase())) onChange([...value, t]);
    setText('');
  };

  return (
    <div className="tags-input">
      {value.map((t) => (
        <span key={t} className="tag tag-editable">
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
            <Icon name="close" size={10} />
          </button>
        </span>
      ))}
      {adding ? (
        <span className="tag-entry">
          <input
            autoFocus
            value={text}
            placeholder="Tag"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ';' || e.key === ',') {
                e.preventDefault();
                add(text);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setAdding(false);
                setText('');
              } else if (e.key === 'Backspace' && !text && value.length) {
                onChange(value.slice(0, -1));
              }
            }}
            onBlur={() => {
              // Delay so a click on a suggestion registers first.
              setTimeout(() => {
                if (text) add(text);
                setAdding(false);
              }, 150);
            }}
          />
          {suggestions.length > 0 && (
            <div className="suggestions">
              {suggestions.map((s) => (
                <button key={s} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </span>
      ) : (
        <button type="button" className="tag tag-add" onClick={() => setAdding(true)}>
          <Icon name="add" size={10} /> Add tag
        </button>
      )}
    </div>
  );
}

/** Search work items by id or title. */
export function WorkItemPicker({
  onPick,
  exclude = [],
  types,
  placeholder = 'Search by ID or title',
  autoFocus,
}: {
  onPick: (item: WorkItem) => void;
  exclude?: number[];
  types?: WorkItemType[];
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const items = useStore((s) => s.workItems);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    const query = q.trim().toLowerCase().replace(/^#/, '');
    const pool = items.filter((w) => !exclude.includes(w.id) && (!types || types.includes(w.type)));
    if (!query) return pool.filter((w) => w.state !== 'Removed').sort((a, b) => b.changedAt.localeCompare(a.changedAt)).slice(0, 8);
    return pool
      .filter((w) => String(w.id) === query || `${w.id} ${w.title}`.toLowerCase().includes(query))
      .sort((a, b) => (String(b.id) === query ? 1 : 0) - (String(a.id) === query ? 1 : 0))
      .slice(0, 12);
  }, [items, q, exclude, types]);
  useEffect(() => setActive(0), [q]);
  return (
    <div className="picker">
      <div className="picker-input">
        <Icon name="search" size={14} />
        <input
          autoFocus={autoFocus}
          value={q}
          placeholder={placeholder}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(results.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && results[active]) {
              e.preventDefault();
              onPick(results[active]);
            }
          }}
        />
      </div>
      <div className="picker-results">
        {results.length === 0 && <div className="muted small pad">No matching work items</div>}
        {results.map((w, idx) => (
          <button key={w.id} type="button" className={`picker-row ${idx === active ? 'active' : ''}`} onMouseEnter={() => setActive(idx)} onClick={() => onPick(w)}>
            <TypeIcon type={w.type} />
            <span className="muted">{w.id}</span>
            <span className="picker-title">{w.title}</span>
            <StateBadge type={w.type} state={w.state} />
          </button>
        ))}
      </div>
    </div>
  );
}

export function MemberSelect({
  value,
  onChange,
  allowUnassigned = true,
  className,
}: {
  value: string | null;
  onChange: (id: string | null) => void;
  allowUnassigned?: boolean;
  className?: string;
}) {
  const members = useStore((s) => s.members);
  const current = members.find((m) => m.id === value);
  return (
    <span className={`member-select ${className ?? ''}`}>
      <Avatar member={current} size={20} />
      <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Assigned to">
        {allowUnassigned && <option value="">Unassigned</option>}
        {members
          .filter((m) => m.active || m.id === value)
          .map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
      </select>
    </span>
  );
}

/** Editor for a list of date ranges (days off). */
export function DateRangesEditor({ value, onChange, min, max }: { value: DateRange[]; onChange: (v: DateRange[]) => void; min?: string | null; max?: string | null }) {
  const [start, setStart] = useState(min ?? '');
  const [end, setEnd] = useState(min ?? '');
  const valid = isValidDate(start) && isValidDate(end) && end >= start;
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="ranges-editor">
      {value.length === 0 && <div className="muted small">No days off</div>}
      {value.map((r, idx) => (
        <div key={idx} className="range-row">
          <Icon name="calendar" size={14} />
          <span>{formatRange(r)}</span>
          <button type="button" className="icon-btn" aria-label="Remove" onClick={() => onChange(value.filter((_, i) => i !== idx))}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <div className="range-add">
        <label>
          Start
          <input
            ref={ref}
            type="date"
            value={start}
            min={min ?? undefined}
            max={max ?? undefined}
            onChange={(e) => {
              setStart(e.target.value);
              if (!end || end < e.target.value) setEnd(e.target.value);
            }}
          />
        </label>
        <label>
          End
          <input type="date" value={end} min={start || (min ?? undefined)} max={max ?? undefined} onChange={(e) => setEnd(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn"
          disabled={!valid}
          onClick={() => {
            onChange([...value, { start, end }].sort((a, b) => a.start.localeCompare(b.start)));
            ref.current?.focus();
          }}
        >
          <Icon name="add" size={12} /> Add
        </button>
      </div>
    </div>
  );
}

/** Number input that commits null for empty values. */
export function NumberInput({
  value,
  onChange,
  min = 0,
  step = 1,
  placeholder,
  className,
  ariaLabel,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  step?: number;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  useEffect(() => setText(value == null ? '' : String(value)), [value]);
  return (
    <input
      type="number"
      className={className}
      aria-label={ariaLabel}
      value={text}
      min={min}
      step={step}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        const n = e.target.value === '' ? null : Number(e.target.value);
        if (n === null || (Number.isFinite(n) && n >= min)) onChange(n);
      }}
    />
  );
}
