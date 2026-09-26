import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { BACKLOG_LEVELS, TYPE_DEFS, canBeParent, stateCategory, type BacklogLevel, type WorkItemType } from '../../../shared/process';
import { formatDayMonth, formatShortDate, workingDaysBetween } from '../../../shared/dates';
import { sprintTimeframe } from '../../../shared/sprints';
import type { WorkItem } from '../../../shared/types';
import { api } from '../api';
import { EmptyState, Person, StateBadge, Tags, useMenu } from '../components/common';
import { FilterBar } from '../components/FilterBar';
import { Icon, TypeIcon } from '../components/Icon';
import { SprintDialog } from '../components/SprintDialog';
import { useWorkItemDialog } from '../components/WorkItemForm';
import { useItemMenu } from '../lib/actions';
import { draggedIds, dropPosition, endDrag, startDrag } from '../lib/dnd';
import { EMPTY_FILTERS, isFiltering, matchesFilters, type Filters } from '../lib/filters';
import { formatHours, formatNumber, iterationName } from '../lib/format';
import { rollup, useChildrenMap, useItemsById, useLocalState, useSortedSprints, useToday } from '../lib/hooks';
import { useStore } from '../store';

export function useLevel(): BacklogLevel | undefined {
  const { level } = useParams();
  return BACKLOG_LEVELS.find((l) => l.key === level);
}

/** Header shared by the backlog and board views of a backlog level. */
export function LevelHeader({ view, level, children }: { view: 'backlog' | 'board'; level: BacklogLevel; children?: ReactNode }) {
  const teamName = useStore((s) => s.settings.teamName);
  const navigate = useNavigate();
  return (
    <div className="page-header">
      <div className="page-title-row">
        <h1>
          <Icon name={view === 'board' ? 'board' : 'backlog'} size={20} /> {teamName}
        </h1>
        <div className="tabs page-tabs">
          <Link className={view === 'backlog' ? 'active' : ''} to={`/backlogs/${level.key}`}>
            Backlog
          </Link>
          <Link className={view === 'board' ? 'active' : ''} to={`/boards/${level.key}`}>
            Board
          </Link>
        </div>
        <div className="spacer" />
        <label className="level-select">
          <select value={level.key} onChange={(e) => navigate(`/${view === 'board' ? 'boards' : 'backlogs'}/${e.target.value}`)} aria-label="Backlog level">
            {BACKLOG_LEVELS.map((l) => (
              <option key={l.key} value={l.key}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="toolbar">{children}</div>
    </div>
  );
}

interface Row {
  kind: 'context' | 'level' | 'child' | 'header' | 'add-child';
  item?: WorkItem;
  depth: number;
  hasChildren?: boolean;
  label?: string;
  addType?: WorkItemType;
}

interface ViewOptions {
  showParents: boolean;
  showInProgress: boolean;
  showCompletedChildren: boolean;
  showPlanned: boolean;
  planningPane: boolean;
  showPastSprints: boolean;
}

const DEFAULT_VIEW: ViewOptions = {
  showParents: false,
  showInProgress: true,
  showCompletedChildren: false,
  showPlanned: true,
  planningPane: true,
  showPastSprints: false,
};

type DropTarget = { id: number; pos: 'before' | 'after' | 'into' } | null;

export function BacklogPage() {
  const level = useLevel();
  if (!level) return <Navigate to="/backlogs/requirements" replace />;
  return <Backlog key={level.key} level={level} />;
}

function Backlog({ level }: { level: BacklogLevel }) {
  const items = useStore((s) => s.workItems);
  const sprints = useStore((s) => s.sprints);
  const projectName = useStore((s) => s.settings.projectName);
  const itemsById = useItemsById();
  const children = useChildrenMap();
  const { open } = useWorkItemDialog();
  const itemMenu = useItemMenu();
  const menu = useMenu();

  const [view, setView] = useLocalState<ViewOptions>(`backlog.${level.key}.view`, DEFAULT_VIEW);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [collapsedCtx, setCollapsedCtx] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [addType, setAddType] = useState<WorkItemType>(level.types[0]);
  const [addTitle, setAddTitle] = useState('');
  const [addBottom, setAddBottom] = useState(false);
  const [childAdd, setChildAdd] = useState<{ parentId: number; type: WorkItemType } | null>(null);
  const [childTitle, setChildTitle] = useState('');
  const [drop, setDrop] = useState<DropTarget>(null);

  const levelTypes = level.types as string[];
  const childTypes = level.childTypes as string[];

  // Every backlog item at this level in rank order (used for the Order column).
  const allLevelItems = useMemo(
    () => items.filter((w) => levelTypes.includes(w.type) && w.state !== 'Removed' && stateCategory(w.type, w.state) !== 'Completed').sort((a, b) => a.stackRank - b.stackRank),
    [items, levelTypes],
  );
  const order = useMemo(() => new Map(allLevelItems.map((w, i) => [w.id, i + 1])), [allLevelItems]);

  const levelItems = useMemo(
    () =>
      allLevelItems.filter((w) => {
        if (!view.showInProgress && stateCategory(w.type, w.state) === 'InProgress') return false;
        if (!view.showPlanned && w.iterationId) return false;
        return matchesFilters(w, filters);
      }),
    [allLevelItems, view.showInProgress, view.showPlanned, filters],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    const pushLevel = (w: WorkItem, depth: number) => {
      const kids = (children.get(w.id) ?? []).filter((c) => childTypes.includes(c.type) && c.state !== 'Removed' && (view.showCompletedChildren || c.state !== 'Done'));
      out.push({ kind: 'level', item: w, depth, hasChildren: kids.length > 0 });
      if (expanded.has(w.id)) for (const c of kids) out.push({ kind: 'child', item: c, depth: depth + 1 });
      if (childAdd?.parentId === w.id) out.push({ kind: 'add-child', depth: depth + 1, item: w, addType: childAdd.type });
    };
    if (!view.showParents) {
      for (const w of levelItems) pushLevel(w, 0);
      return out;
    }
    // Hierarchy mode: include ancestors of visible items as context rows.
    const visible = new Set(levelItems.map((w) => w.id));
    const context = new Set<number>();
    for (const w of levelItems) {
      for (let p = w.parentId != null ? itemsById.get(w.parentId) : undefined; p; p = p.parentId != null ? itemsById.get(p.parentId) : undefined) {
        context.add(p.id);
      }
    }
    const walk = (node: WorkItem, depth: number) => {
      if (visible.has(node.id)) return pushLevel(node, depth);
      const kids = (children.get(node.id) ?? []).filter((c) => visible.has(c.id) || context.has(c.id));
      out.push({ kind: 'context', item: node, depth, hasChildren: kids.length > 0 });
      if (!collapsedCtx.has(node.id)) for (const k of kids) walk(k, depth + 1);
    };
    const roots = [...context].map((id) => itemsById.get(id)!).filter((w) => w.parentId == null || !context.has(w.parentId));
    roots.sort((a, b) => a.stackRank - b.stackRank).forEach((r) => walk(r, 0));
    const orphans = levelItems.filter((w) => w.parentId == null || !itemsById.has(w.parentId));
    if (orphans.length && roots.length) out.push({ kind: 'header', depth: 0, label: `Unparented ${level.name.toLowerCase()}` });
    for (const w of orphans) pushLevel(w, 0);
    return out;
  }, [levelItems, children, childTypes, view.showParents, view.showCompletedChildren, expanded, collapsedCtx, itemsById, childAdd, level.name]);

  const selectedItems = [...selected].map((id) => itemsById.get(id)).filter((w): w is WorkItem => !!w);

  const onRowClick = (e: React.MouseEvent, w: WorkItem) => {
    if (e.shiftKey && anchor != null) {
      const ids = rows.filter((r) => r.item && (r.kind === 'level' || r.kind === 'child')).map((r) => r.item!.id);
      const a = ids.indexOf(anchor);
      const b = ids.indexOf(w.id);
      if (a >= 0 && b >= 0) {
        setSelected(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(w.id)) next.delete(w.id);
      else next.add(w.id);
      setSelected(next);
    } else setSelected(new Set([w.id]));
    setAnchor(w.id);
  };

  const openMenu = (e: React.MouseEvent, w: WorkItem) => {
    const sel = selected.has(w.id) ? selectedItems : [w];
    if (!selected.has(w.id)) setSelected(new Set([w.id]));
    menu.openAt(
      e,
      itemMenu.build(sel, {
        reorderWithin: sel.every((s) => levelTypes.includes(s.type)) ? allLevelItems : undefined,
        onAddChild: (parent, type) => startChildAdd(parent, type),
      }),
    );
  };

  const startChildAdd = (parent: WorkItem, type: WorkItemType) => {
    setChildAdd({ parentId: parent.id, type });
    setChildTitle('');
    setExpanded((s) => new Set(s).add(parent.id));
  };

  const addItem = async () => {
    const title = addTitle.trim();
    if (!title) return;
    const created = await api.createWorkItem(addType, { title, position: addBottom ? 'bottom' : 'top' });
    setAddTitle('');
    setSelected(new Set([created.id]));
  };

  const addChild = async () => {
    if (!childAdd || !childTitle.trim()) return;
    const parent = itemsById.get(childAdd.parentId);
    await api.createWorkItem(childAdd.type, {
      title: childTitle.trim(),
      parentId: childAdd.parentId,
      iterationId: childAdd.type === 'Task' ? parent?.iterationId : undefined,
      assignedTo: childAdd.type === 'Task' ? parent?.assignedTo : undefined,
    });
    setChildTitle('');
  };

  // ---- drag & drop -----------------------------------------------------------
  const canDropOn = (row: Row, e: React.DragEvent): DropTarget => {
    const ids = draggedIds();
    const target = row.item;
    if (!ids.length || !target || ids.includes(target.id)) return null;
    const dragged = ids.map((id) => itemsById.get(id)).filter((w): w is WorkItem => !!w);
    if (!dragged.length) return null;
    const allLevel = dragged.every((w) => levelTypes.includes(w.type));
    const allChild = dragged.every((w) => childTypes.includes(w.type));
    if (row.kind === 'level' && allLevel) return { id: target.id, pos: dropPosition(e) };
    if (row.kind === 'context' && allLevel && dragged.every((w) => canBeParent(target.type, w.type))) return { id: target.id, pos: 'into' };
    if (row.kind === 'level' && allChild && dragged.every((w) => canBeParent(target.type, w.type))) return { id: target.id, pos: 'into' };
    if (row.kind === 'child' && allChild) return { id: target.id, pos: dropPosition(e) };
    return null;
  };

  const performDrop = async (target: WorkItem, pos: 'before' | 'after' | 'into') => {
    const dragged = draggedIds()
      .map((id) => itemsById.get(id))
      .filter((w): w is WorkItem => !!w)
      .sort((a, b) => a.stackRank - b.stackRank);
    endDrag();
    if (!dragged.length) return;
    if (pos === 'into') {
      const siblings = (children.get(target.id) ?? []).filter((c) => !dragged.includes(c));
      let after: number | null = siblings.length ? siblings[siblings.length - 1].id : null;
      for (const w of dragged) {
        await api.moveWorkItem(w.id, { parentId: target.id, afterId: after });
        after = w.id;
      }
      if (childTypes.includes(dragged[0].type)) setExpanded((s) => new Set(s).add(target.id));
      return;
    }
    // Reordering; in hierarchy mode (or for child rows) adopt the target's parent.
    const reparent = (view.showParents || childTypes.includes(target.type)) && dragged.some((w) => w.parentId !== target.parentId);
    let anchorId = target.id;
    for (const [idx, w] of dragged.entries()) {
      const input = idx === 0 && pos === 'before' ? { beforeId: target.id } : { afterId: anchorId };
      await api.moveWorkItem(w.id, reparent ? { ...input, parentId: target.parentId } : input);
      anchorId = w.id;
    }
  };

  const toggleExpand = (row: Row) => {
    const id = row.item!.id;
    if (row.kind === 'context') {
      const next = new Set(collapsedCtx);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setCollapsedCtx(next);
    } else {
      const next = new Set(expanded);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setExpanded(next);
    }
  };

  const expandAll = () => {
    setExpanded(new Set(levelItems.map((w) => w.id)));
    setCollapsedCtx(new Set());
  };
  const collapseAll = () => {
    setExpanded(new Set());
    setCollapsedCtx(new Set(rows.filter((r) => r.kind === 'context').map((r) => r.item!.id)));
  };

  const isRequirements = level.key === 'requirements';
  const columns = isRequirements
    ? ['Order', 'Title', 'State', 'Effort', 'Remaining', 'Assigned To', 'Iteration', 'Tags']
    : ['Order', 'Title', 'State', 'Progress', 'Effort', 'Business Value', 'Target Date', 'Tags'];

  const viewMenu = [
    { label: 'Parents', checked: view.showParents, disabled: level.key === 'epics', onClick: () => setView({ ...view, showParents: !view.showParents }) },
    { label: 'In progress items', checked: view.showInProgress, onClick: () => setView({ ...view, showInProgress: !view.showInProgress }) },
    { label: 'Completed child items', checked: view.showCompletedChildren, onClick: () => setView({ ...view, showCompletedChildren: !view.showCompletedChildren }) },
    { label: 'Items planned in sprints', checked: view.showPlanned, onClick: () => setView({ ...view, showPlanned: !view.showPlanned }) },
    { divider: true },
    { label: 'Planning pane', checked: view.planningPane, onClick: () => setView({ ...view, planningPane: !view.planningPane }) },
  ];

  return (
    <div className="page">
      <LevelHeader view="backlog" level={level}>
        <button className="btn btn-primary-ghost" onClick={() => setAdding(!adding)}>
          <Icon name="add" size={14} /> New {level.itemName}
        </button>
        {selected.size > 0 && (
          <button className="btn" onClick={(e) => menu.openAt(e, itemMenu.build(selectedItems, { reorderWithin: allLevelItems }))}>
            {selected.size} selected <Icon name="chevronDown" size={12} />
          </button>
        )}
        <div className="spacer" />
        <button className="icon-btn" title="Expand all" onClick={expandAll}>
          <Icon name="expandAll" />
        </button>
        <button className="icon-btn" title="Collapse all" onClick={collapseAll}>
          <Icon name="collapseAll" />
        </button>
        <button className="btn btn-ghost" onClick={(e) => menu.openAt(e, viewMenu)}>
          View options <Icon name="chevronDown" size={12} />
        </button>
        <button className={`icon-btn ${filterOpen || isFiltering(filters) ? 'active' : ''}`} title="Filter" onClick={() => setFilterOpen(!filterOpen)}>
          <Icon name="filter" />
        </button>
        <button className={`icon-btn ${view.planningPane ? 'active' : ''}`} title="Planning pane" onClick={() => setView({ ...view, planningPane: !view.planningPane })}>
          <Icon name="pane" />
        </button>
      </LevelHeader>
      {filterOpen && <FilterBar value={filters} onChange={setFilters} types={level.types} onClose={() => setFilterOpen(false)} />}
      <div className="page-body split">
        <div className="grid-wrap">
          {adding && (
            <div className="add-panel">
              {level.types.length > 1 && (
                <select value={addType} onChange={(e) => setAddType(e.target.value as WorkItemType)} aria-label="Type">
                  {level.types.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              )}
              <TypeIcon type={addType} />
              <input
                autoFocus
                value={addTitle}
                placeholder="Enter title"
                onChange={(e) => setAddTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addItem();
                  if (e.key === 'Escape') setAdding(false);
                }}
                aria-label="New work item title"
              />
              <label className="check-row">
                <input type="checkbox" checked={addBottom} onChange={(e) => setAddBottom(e.target.checked)} /> Add to bottom
              </label>
              <button className="btn btn-primary" onClick={addItem} disabled={!addTitle.trim()}>
                {addBottom ? 'Add to bottom' : 'Add to top'}
              </button>
              <button className="icon-btn" onClick={() => setAdding(false)} aria-label="Close">
                <Icon name="close" size={12} />
              </button>
            </div>
          )}
          {rows.length === 0 ? (
            <EmptyState icon="backlog" title={isFiltering(filters) ? 'No items match the filter' : `Your ${level.name.toLowerCase()} backlog is empty`}>
              {!isFiltering(filters) && (
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  <Icon name="add" size={12} /> New {level.itemName}
                </button>
              )}
            </EmptyState>
          ) : (
            <table className="grid backlog-grid">
              <thead>
                <tr>
                  <th className="col-drag" />
                  {columns.map((c) => (
                    <th key={c} className={`col-${c.toLowerCase().replace(/\s+/g, '-')}`}>
                      {c}
                    </th>
                  ))}
                  <th className="col-actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, idx) => {
                  if (row.kind === 'header') {
                    return (
                      <tr key={`h${idx}`} className="row-header">
                        <td />
                        <td colSpan={columns.length + 1}>{row.label}</td>
                      </tr>
                    );
                  }
                  if (row.kind === 'add-child') {
                    return (
                      <tr key={`add${idx}`} className="row-add-child">
                        <td />
                        <td colSpan={columns.length + 1}>
                          <div className="inline-add" style={{ paddingLeft: 24 + row.depth * 20 }}>
                            <TypeIcon type={row.addType!} />
                            <input
                              autoFocus
                              placeholder={`New ${row.addType} title, Enter to add`}
                              value={childTitle}
                              onChange={(e) => setChildTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') void addChild();
                                if (e.key === 'Escape') setChildAdd(null);
                              }}
                              onBlur={() => !childTitle && setChildAdd(null)}
                            />
                            <button className="btn" onMouseDown={(e) => e.preventDefault()} onClick={addChild} disabled={!childTitle.trim()}>
                              Add
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }
                  const w = row.item!;
                  const r = rollup(w, children);
                  const isDrop = drop?.id === w.id;
                  const doneKids = (children.get(w.id) ?? []).filter((c) => c.state !== 'Removed');
                  const pct = doneKids.length ? Math.round((doneKids.filter((c) => c.state === 'Done').length / doneKids.length) * 100) : null;
                  return (
                    <tr
                      key={`${row.kind}-${w.id}`}
                      className={[
                        'grid-row',
                        `row-${row.kind}`,
                        selected.has(w.id) ? 'selected' : '',
                        isDrop ? `drop-${drop!.pos}` : '',
                      ].join(' ')}
                      draggable={row.kind !== 'context'}
                      onDragStart={(e) => {
                        const ids = selected.has(w.id) && row.kind === 'level' ? selectedItems.filter((s) => levelTypes.includes(s.type)).map((s) => s.id) : [w.id];
                        startDrag(e, ids);
                      }}
                      onDragEnd={() => {
                        endDrag();
                        setDrop(null);
                      }}
                      onDragOver={(e) => {
                        const t = canDropOn(row, e);
                        if (!t) return;
                        e.preventDefault();
                        if (t.id !== drop?.id || t.pos !== drop?.pos) setDrop(t);
                      }}
                      onDragLeave={() => setDrop(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        const t = drop;
                        setDrop(null);
                        if (t) void performDrop(w, t.pos);
                      }}
                      onClick={(e) => onRowClick(e, w)}
                      onDoubleClick={() => open(w.id)}
                      onContextMenu={(e) => openMenu(e, w)}
                    >
                      <td className="col-drag">{row.kind !== 'context' && <Icon name="drag" size={12} />}</td>
                      <td className="col-order muted">{row.kind === 'level' ? order.get(w.id) : ''}</td>
                      <td className="col-title">
                        <div className="title-cell" style={{ paddingLeft: row.depth * 20 }}>
                          {row.hasChildren ? (
                            <button
                              className="expander"
                              aria-label={(row.kind === 'context' ? !collapsedCtx.has(w.id) : expanded.has(w.id)) ? 'Collapse' : 'Expand'}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(row);
                              }}
                            >
                              <Icon name={(row.kind === 'context' ? !collapsedCtx.has(w.id) : expanded.has(w.id)) ? 'chevronDown' : 'chevronRight'} size={12} />
                            </button>
                          ) : (
                            <span className="expander-spacer" />
                          )}
                          <TypeIcon type={w.type} />
                          <button
                            title={w.title}
                            className={`title-link ${row.kind === 'context' ? 'context' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              open(w.id);
                            }}
                          >
                            {w.title}
                          </button>
                          {w.blocked && <span className="badge badge-danger">Blocked</span>}
                          {TYPE_DEFS[w.type].childTypes.length > 0 && row.kind !== 'context' && (
                            <button
                              className="icon-btn row-add"
                              title={`Add ${TYPE_DEFS[w.type].childTypes[0]}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                const types = TYPE_DEFS[w.type].childTypes;
                                if (types.length === 1) startChildAdd(w, types[0]);
                                else menu.openAt(e, types.map((t) => ({ label: t, onClick: () => startChildAdd(w, t) })));
                              }}
                            >
                              <Icon name="add" size={12} />
                            </button>
                          )}
                        </div>
                      </td>
                      <td>
                        <StateBadge type={w.type} state={w.state} />
                      </td>
                      {isRequirements ? (
                        <>
                          <td className="num">{formatNumber(w.effort)}</td>
                          <td className="num">{r.hasChildren ? formatHours(r.remaining) : formatHours(w.remainingWork)}</td>
                          <td>
                            <Person id={w.assignedTo} />
                          </td>
                          <td className="muted">{iterationName(sprints, w.iterationId, projectName)}</td>
                        </>
                      ) : (
                        <>
                          <td>
                            {pct != null && (
                              <div className="mini-progress" title={`${pct}% of child items done`}>
                                <div style={{ width: `${pct}%` }} />
                              </div>
                            )}
                          </td>
                          <td className="num">{formatNumber(w.effort)}</td>
                          <td className="num">{formatNumber(w.businessValue)}</td>
                          <td>{formatShortDate(w.targetDate)}</td>
                        </>
                      )}
                      <td>
                        <Tags tags={w.tags} max={3} />
                      </td>
                      <td className="col-actions">
                        <button className="icon-btn row-more" aria-label="Actions" onClick={(e) => openMenu(e, w)}>
                          <Icon name="more" size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {view.planningPane && <PlanningPane level={level} showPast={view.showPastSprints} onTogglePast={() => setView({ ...view, showPastSprints: !view.showPastSprints })} selectedIds={[...selected]} />}
      </div>
      {menu.element}
      {itemMenu.element}
    </div>
  );
}

function PlanningPane({ level, showPast, onTogglePast, selectedIds }: { level: BacklogLevel; showPast: boolean; onTogglePast: () => void; selectedIds: number[] }) {
  const sprints = useSortedSprints();
  const items = useStore((s) => s.workItems);
  const projectName = useStore((s) => s.settings.projectName);
  const workingDays = useStore((s) => s.settings.workingDays);
  const today = useToday();
  const [over, setOver] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const itemMenu = useItemMenu();

  const stats = (iterationId: string | null) => {
    const list = items.filter((w) => (w.iterationId ?? null) === iterationId && level.types.includes(w.type) && w.state !== 'Removed');
    return { count: list.length, effort: list.reduce((s, w) => s + (w.effort ?? 0), 0) };
  };

  const onDrop = async (e: React.DragEvent, iterationId: string | null) => {
    e.preventDefault();
    setOver(null);
    const ids = draggedIds();
    endDrag();
    if (ids.length) await itemMenu.moveTo(ids, iterationId);
  };

  const visible = sprints.filter((s) => showPast || sprintTimeframe(s, today) !== 'past');
  const pastCount = sprints.length - sprints.filter((s) => sprintTimeframe(s, today) !== 'past').length;

  const target = (key: string, iterationId: string | null, content: ReactNode, className = '') => (
    <div
      key={key}
      className={`plan-target ${className} ${over === key ? 'over' : ''}`}
      onDragOver={(e) => {
        if (!draggedIds().length) return;
        e.preventDefault();
        setOver(key);
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(e) => onDrop(e, iterationId)}
    >
      {content}
    </div>
  );

  const backlog = stats(null);
  return (
    <aside className="side-pane planning-pane">
      <div className="side-pane-header">
        <h3>Planning</h3>
        <button className="link-btn small" onClick={() => setCreating(true)}>
          <Icon name="add" size={12} /> New sprint
        </button>
      </div>
      <div className="muted small pad-x">Drag items onto a sprint to plan them, or onto the backlog to unschedule them.</div>
      {selectedIds.length > 0 && <div className="muted small pad-x">{selectedIds.length} selected — drag any selected row to move them all.</div>}
      {target(
        'backlog',
        null,
        <>
          <div className="plan-name">
            <Icon name="backlog" size={14} /> {projectName} backlog
          </div>
          <div className="muted small">
            Unscheduled · {backlog.count} items · {formatNumber(backlog.effort)} effort
          </div>
        </>,
        'plan-backlog',
      )}
      {pastCount > 0 && (
        <button className="link-btn small pad-x" onClick={onTogglePast}>
          {showPast ? 'Hide' : 'Show'} {pastCount} past sprint{pastCount === 1 ? '' : 's'}
        </button>
      )}
      {visible.map((s) => {
        const st = stats(s.id);
        const tf = sprintTimeframe(s, today);
        const days = s.startDate && s.finishDate ? workingDaysBetween(s.startDate, s.finishDate, workingDays).length : 0;
        return target(
          s.id,
          s.id,
          <>
            <div className="plan-name">
              <Link to={`/sprints/${s.id}/backlog`}>{s.name}</Link>
              {tf === 'current' && <span className="badge badge-current">Current</span>}
              {tf === 'past' && <span className="badge">Past</span>}
            </div>
            <div className="muted small">{s.startDate ? `${formatDayMonth(s.startDate)} – ${formatShortDate(s.finishDate)} · ${days} working days` : 'No dates'}</div>
            <div className="small">
              {st.count} items · {formatNumber(st.effort)} effort
            </div>
          </>,
          `plan-sprint ${tf}`,
        );
      })}
      {creating && <SprintDialog onClose={() => setCreating(false)} />}
    </aside>
  );
}

