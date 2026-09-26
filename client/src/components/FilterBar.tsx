import { useMemo } from 'react';
import { TYPE_DEFS, type WorkItemType } from '../../../shared/process';
import { EMPTY_FILTERS, isFiltering, type Filters } from '../lib/filters';
import { useSortedSprints } from '../lib/hooks';
import { useStore } from '../store';
import { MultiSelect } from './common';
import { Icon, TypeIcon } from './Icon';

export function FilterBar({
  value,
  onChange,
  types,
  showIteration = true,
  onClose,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  types: WorkItemType[];
  showIteration?: boolean;
  onClose?: () => void;
}) {
  const members = useStore((s) => s.members);
  const items = useStore((s) => s.workItems);
  const projectName = useStore((s) => s.settings.projectName);
  const sprints = useSortedSprints();
  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const w of items) if (types.includes(w.type)) for (const t of w.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items, types]);
  const states = useMemo(() => [...new Set(types.flatMap((t) => TYPE_DEFS[t].states.map((s) => s.name)))], [types]);
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });

  return (
    <div className="filter-bar">
      <div className="filter-keyword">
        <Icon name="filter" size={14} />
        <input autoFocus value={value.keyword} onChange={(e) => set({ keyword: e.target.value })} placeholder="Filter by keyword or ID" aria-label="Filter by keyword" />
      </div>
      {types.length > 1 && (
        <MultiSelect
          label="Types"
          value={value.types}
          onChange={(v) => set({ types: v })}
          options={types.map((t) => ({
            value: t,
            label: (
              <span className="row gap-s">
                <TypeIcon type={t} /> {t}
              </span>
            ),
          }))}
        />
      )}
      <MultiSelect
        label="Assigned to"
        value={value.assignedTo}
        onChange={(v) => set({ assignedTo: v })}
        options={[{ value: '', label: 'Unassigned' }, ...members.map((m) => ({ value: m.id, label: m.name }))]}
      />
      <MultiSelect label="States" value={value.states} onChange={(v) => set({ states: v })} options={states.map((s) => ({ value: s, label: s }))} />
      <MultiSelect label="Tags" value={value.tags} onChange={(v) => set({ tags: v })} options={tags.map((t) => ({ value: t, label: t }))} />
      {showIteration && (
        <MultiSelect
          label="Iteration"
          value={value.iterations}
          onChange={(v) => set({ iterations: v })}
          options={[{ value: '', label: `${projectName} (Backlog)` }, ...sprints.map((s) => ({ value: s.id, label: s.name }))]}
        />
      )}
      {isFiltering(value) && (
        <button className="link-btn" onClick={() => onChange(EMPTY_FILTERS)}>
          Clear filters
        </button>
      )}
      {onClose && (
        <button className="icon-btn filter-close" onClick={onClose} aria-label="Close filters">
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}
