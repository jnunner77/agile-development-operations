import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { WORK_ITEM_TYPES } from '../../../shared/process';
import { formatShortDate } from '../../../shared/dates';
import type { WorkItem } from '../../../shared/types';
import { EmptyState, Person, StateBadge, Tags, useMenu } from '../components/common';
import { FilterBar } from '../components/FilterBar';
import { Icon, TypeIcon } from '../components/Icon';
import { useWorkItemDialog } from '../components/WorkItemForm';
import { useItemMenu } from '../lib/actions';
import { EMPTY_FILTERS, matchesFilters, type Filters } from '../lib/filters';
import { iterationName, timeAgo } from '../lib/format';
import { useMembersById } from '../lib/hooks';
import { useStore } from '../store';

type SortKey = 'id' | 'title' | 'type' | 'state' | 'assignedTo' | 'iteration' | 'dueDate' | 'changedAt';

const PAGE = 200;

export function WorkItemsPage() {
  const items = useStore((s) => s.workItems);
  const sprints = useStore((s) => s.sprints);
  const projectName = useStore((s) => s.settings.projectName);
  const members = useMembersById();
  const [params] = useSearchParams();
  const q = params.get('q');
  const [filters, setFilters] = useState<Filters>({ ...EMPTY_FILTERS, keyword: q ?? '' });
  // The top bar search navigates here with ?q=; pick up new searches while already on the page.
  useEffect(() => {
    if (q !== null) setFilters((f) => ({ ...f, keyword: q }));
  }, [q]);
  const [showClosed, setShowClosed] = useState(true);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'changedAt', dir: -1 });
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const { open, openNew } = useWorkItemDialog();
  const menu = useMenu();
  const itemMenu = useItemMenu();

  const rows = useMemo(() => {
    const value = (w: WorkItem): string | number => {
      switch (sort.key) {
        case 'assignedTo':
          return w.assignedTo ? (members.get(w.assignedTo)?.name ?? '') : '￿';
        case 'iteration':
          return iterationName(sprints, w.iterationId, projectName);
        case 'dueDate':
          return w.dueDate ?? '￿';
        default:
          return w[sort.key] as string | number;
      }
    };
    return items
      .filter((w) => (showClosed || (w.state !== 'Done' && w.state !== 'Removed')) && matchesFilters(w, filters))
      .sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        return (typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb))) * sort.dir;
      });
  }, [items, filters, showClosed, sort, members, sprints, projectName]);

  const header = (key: SortKey, label: string, className = '') => (
    <th className={`sortable ${className}`} onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : 1 }))}>
      {label}
      {sort.key === key && <Icon name={sort.dir === 1 ? 'chevronDown' : 'collapseAll'} size={10} />}
    </th>
  );

  const selectedItems = rows.filter((w) => selected.has(w.id));

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <h1>
            <Icon name="workitems" size={20} /> Work items
          </h1>
          <div className="spacer" />
        </div>
        <div className="toolbar">
          <button className="btn btn-primary-ghost" onClick={(e) => menu.openAt(e, WORK_ITEM_TYPES.map((t) => ({ label: t, onClick: () => openNew(t) })))}>
            <Icon name="add" size={14} /> New work item <Icon name="chevronDown" size={12} />
          </button>
          {selected.size > 0 && (
            <button className="btn" onClick={(e) => menu.openAt(e, itemMenu.build(selectedItems))}>
              {selected.size} selected <Icon name="chevronDown" size={12} />
            </button>
          )}
          <div className="spacer" />
          <label className="check-row">
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show done &amp; removed
          </label>
          <span className="muted small hide-sm">{rows.length} items</span>
        </div>
      </div>
      <FilterBar value={filters} onChange={setFilters} types={[...WORK_ITEM_TYPES]} />
      <div className="page-body">
        {rows.length === 0 ? (
          <EmptyState title="No work items match" />
        ) : (
          <div className="grid-wrap">
            <table className="grid">
              <thead>
                <tr>
                  <th className="col-check">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={selected.size > 0 && selectedItems.length === Math.min(rows.length, limit)}
                      onChange={(e) => setSelected(e.target.checked ? new Set(rows.slice(0, limit).map((w) => w.id)) : new Set())}
                    />
                  </th>
                  {header('id', 'ID')}
                  {header('type', 'Type')}
                  {header('title', 'Title', 'col-title')}
                  {header('state', 'State')}
                  {header('assignedTo', 'Assigned To', 'hide-sm')}
                  {header('iteration', 'Iteration', 'hide-sm')}
                  <th className="hide-sm">Tags</th>
                  {header('dueDate', 'Due', 'hide-sm')}
                  {header('changedAt', 'Updated', 'hide-sm')}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((w) => (
                  <tr
                    key={w.id}
                    className={`grid-row ${selected.has(w.id) ? 'selected' : ''}`}
                    onDoubleClick={() => open(w.id)}
                    onContextMenu={(e) => menu.openAt(e, itemMenu.build(selected.has(w.id) ? selectedItems : [w]))}
                  >
                    <td className="col-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${w.id}`}
                        checked={selected.has(w.id)}
                        onChange={() => {
                          const next = new Set(selected);
                          if (next.has(w.id)) next.delete(w.id);
                          else next.add(w.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className="muted">{w.id}</td>
                    <td>
                      <span className="row gap-s">
                        <TypeIcon type={w.type} /> <span className="hide-sm">{w.type}</span>
                      </span>
                    </td>
                    <td className="col-title">
                      <button className="title-link" title={w.title} onClick={() => open(w.id)}>
                        {w.title}
                      </button>
                    </td>
                    <td>
                      <StateBadge type={w.type} state={w.state} />
                    </td>
                    <td className="hide-sm">
                      <Person id={w.assignedTo} />
                    </td>
                    <td className="muted hide-sm">{iterationName(sprints, w.iterationId, projectName)}</td>
                    <td className="hide-sm">
                      <Tags tags={w.tags} max={2} />
                    </td>
                    <td className="hide-sm">{formatShortDate(w.dueDate)}</td>
                    <td className="muted small hide-sm" title={new Date(w.changedAt).toLocaleString()}>
                      {timeAgo(w.changedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > limit && (
              <button className="btn pad" onClick={() => setLimit(limit + PAGE)}>
                Show more ({rows.length - limit} remaining)
              </button>
            )}
          </div>
        )}
      </div>
      {menu.element}
      {itemMenu.element}
    </div>
  );
}
