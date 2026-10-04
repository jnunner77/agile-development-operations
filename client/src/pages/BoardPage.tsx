import { useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { TYPE_DEFS, defaultState, type BacklogLevel, type WorkItemType } from '../../../shared/process';
import { formatShortDate } from '../../../shared/dates';
import type { WorkItem } from '../../../shared/types';
import { api } from '../api';
import { AssigneePicker, Tags, useMenu } from '../components/common';
import { FilterBar } from '../components/FilterBar';
import { Icon, TypeIcon } from '../components/Icon';
import { useWorkItemDialog } from '../components/WorkItemForm';
import { ChecksIcon, PrStateBadge } from '../components/Development';
import { useItemMenu } from '../lib/actions';
import { draggedIds, dropPosition, endDrag, startDrag } from '../lib/dnd';
import { EMPTY_FILTERS, isFiltering, matchesFilters, type Filters } from '../lib/filters';
import { formatNumber, iterationName } from '../lib/format';
import { useChildrenMap, useFolds, useItemsById, useLocalState, useToday } from '../lib/hooks';
import { useStore } from '../store';
import { LevelHeader, useLevel } from './BacklogPage';

const DONE_LIMIT = 20;

export function BoardPage() {
  const level = useLevel();
  if (!level) return <Navigate to="/boards/requirements" replace />;
  return <Board key={level.key} level={level} />;
}

function Board({ level }: { level: BacklogLevel }) {
  const items = useStore((s) => s.workItems);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filterOpen, setFilterOpen] = useState(false);
  const [opts, setOpts] = useLocalState(`board.${level.key}`, { showAllDone: false, showChildren: true });
  const [drop, setDrop] = useState<{ column: string; id: number | null; pos: 'before' | 'after' } | null>(null);
  const [adding, setAdding] = useState(false);
  const [addTitle, setAddTitle] = useState('');
  const [addType, setAddType] = useState<WorkItemType>(level.types[0]);
  const itemsById = useItemsById();
  const menu = useMenu();
  const itemMenu = useItemMenu();
  // Which cards show their child items, remembered for the current user.
  const folds = useFolds(`board.${level.key}`, false, (id) => itemsById.has(Number(id)));

  const columns = useMemo(() => {
    const byColumn = new Map<string, WorkItem[]>(level.columns.map((c) => [c, []]));
    const list = items.filter((w) => (level.types as string[]).includes(w.type) && w.state !== 'Removed' && matchesFilters(w, filters)).sort((a, b) => a.stackRank - b.stackRank);
    for (const w of list) byColumn.get(w.state)?.push(w);
    const done = byColumn.get('Done');
    if (done) done.sort((a, b) => (b.closedAt ?? b.changedAt).localeCompare(a.closedAt ?? a.changedAt));
    return byColumn;
  }, [items, level, filters]);

  const onDrop = async (column: string) => {
    const target = drop;
    setDrop(null);
    const ids = draggedIds();
    endDrag();
    const dragged = ids.map((id) => itemsById.get(id)).filter((w): w is WorkItem => !!w);
    const cards = (columns.get(column) ?? []).filter((c) => !ids.includes(c.id));
    for (const w of dragged) {
      const input: Parameters<typeof api.moveWorkItem>[1] = {};
      if (w.state !== column) input.state = column;
      if (column !== 'Done') {
        if (target?.id != null) input[target.pos === 'before' ? 'beforeId' : 'afterId'] = target.id;
        else if (cards.length) input.afterId = cards[cards.length - 1].id;
      }
      if (Object.keys(input).length) await api.moveWorkItem(w.id, input);
    }
  };

  const addItem = async () => {
    if (!addTitle.trim()) return;
    await api.createWorkItem(addType, { title: addTitle.trim(), position: 'top', state: defaultState(addType) });
    setAddTitle('');
  };

  return (
    <div className="page">
      <LevelHeader view="board" level={level}>
        <button className="btn btn-primary-ghost" onClick={() => setAdding(true)}>
          <Icon name="add" size={14} /> New item
        </button>
        <div className="spacer" />
        <button
          className="btn btn-ghost"
          onClick={(e) =>
            menu.openAt(e, [
              { label: 'Show child items on cards', checked: opts.showChildren, onClick: () => setOpts({ ...opts, showChildren: !opts.showChildren }) },
              { label: 'Show all completed items', checked: opts.showAllDone, onClick: () => setOpts({ ...opts, showAllDone: !opts.showAllDone }) },
            ])
          }
        >
          <span className="btn-label">View options</span> <Icon name="settings" size={14} className="show-sm" /> <Icon name="chevronDown" size={12} />
        </button>
        {opts.showChildren && (
          <>
            <button className="btn btn-ghost" title="Expand all" aria-label="Expand all" onClick={() => folds.setAll(true)}>
              <Icon name="expandAll" size={14} /> <span className="btn-label">Expand all</span>
            </button>
            <button className="btn btn-ghost" title="Collapse all" aria-label="Collapse all" onClick={() => folds.setAll(false)}>
              <Icon name="collapseAll" size={14} /> <span className="btn-label">Collapse all</span>
            </button>
          </>
        )}
        <button className={`icon-btn ${filterOpen || isFiltering(filters) ? 'active' : ''}`} title="Filter" onClick={() => setFilterOpen(!filterOpen)}>
          <Icon name="filter" />
        </button>
      </LevelHeader>
      {filterOpen && <FilterBar value={filters} onChange={setFilters} types={level.types} onClose={() => setFilterOpen(false)} />}
      <div className="page-body">
        <div className="board">
          {level.columns.map((column, colIdx) => {
            const all = columns.get(column) ?? [];
            const cards = column === 'Done' && !opts.showAllDone ? all.slice(0, DONE_LIMIT) : all;
            return (
              <div
                key={column}
                className={`board-column ${drop?.column === column ? 'drop-active' : ''}`}
                onDragOver={(e) => {
                  if (!draggedIds().length) return;
                  e.preventDefault();
                  if (drop?.column !== column || drop.id !== null) {
                    if (!(e.target as HTMLElement).closest('.card')) setDrop({ column, id: null, pos: 'after' });
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void onDrop(column);
                }}
              >
                <div className="board-column-header">
                  <span>{column}</span>
                  <span className="count-pill">{all.length}</span>
                </div>
                <div className="board-column-body">
                  {colIdx === 0 && adding && (
                    <div className="card card-new">
                      {level.types.length > 1 && (
                        <select value={addType} onChange={(e) => setAddType(e.target.value as WorkItemType)}>
                          {level.types.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                      )}
                      <textarea
                        autoFocus
                        placeholder="Enter title, press Enter to add"
                        value={addTitle}
                        onChange={(e) => setAddTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void addItem();
                          }
                          if (e.key === 'Escape') setAdding(false);
                        }}
                        onBlur={() => !addTitle && setAdding(false)}
                      />
                    </div>
                  )}
                  {colIdx === 0 && !adding && (
                    <button className="board-add" onClick={() => setAdding(true)}>
                      <Icon name="add" size={12} /> New item
                    </button>
                  )}
                  {cards.map((w) => (
                    <BoardCard
                      key={w.id}
                      item={w}
                      showChildren={opts.showChildren}
                      expanded={folds.isOpen(w.id)}
                      onExpandedChange={(v) => folds.setOpen(w.id, v)}
                      dropPos={drop?.id === w.id ? drop.pos : null}
                      onDragOver={(e) => {
                        if (!draggedIds().length || draggedIds().includes(w.id)) return;
                        e.preventDefault();
                        const pos = dropPosition(e);
                        if (drop?.id !== w.id || drop.pos !== pos) setDrop({ column, id: w.id, pos });
                      }}
                      onMenu={(e) => menu.openAt(e, itemMenu.build([w], { reorderWithin: all }))}
                    />
                  ))}
                  {column === 'Done' && !opts.showAllDone && all.length > DONE_LIMIT && (
                    <button className="link-btn small pad" onClick={() => setOpts({ ...opts, showAllDone: true })}>
                      Show {all.length - DONE_LIMIT} more
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {menu.element}
      {itemMenu.element}
    </div>
  );
}

function BoardCard({
  item,
  showChildren,
  expanded,
  onExpandedChange,
  dropPos,
  onDragOver,
  onMenu,
}: {
  item: WorkItem;
  showChildren: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  dropPos: 'before' | 'after' | null;
  onDragOver: (e: React.DragEvent) => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const { open } = useWorkItemDialog();
  const children = useChildrenMap();
  const sprints = useStore((s) => s.sprints);
  const projectName = useStore((s) => s.settings.projectName);
  const today = useToday();
  const [adding, setAdding] = useState(false);
  const [childTitle, setChildTitle] = useState('');
  const kids = (children.get(item.id) ?? []).filter((c) => c.state !== 'Removed');
  const done = kids.filter((c) => c.state === 'Done').length;
  const childType = TYPE_DEFS[item.type].childTypes[0];
  const overdue = item.dueDate && item.dueDate < today && item.state !== 'Done';

  const addChild = async () => {
    if (!childTitle.trim() || !childType) return;
    await api.createWorkItem(childType, {
      title: childTitle.trim(),
      parentId: item.id,
      iterationId: childType === 'Task' ? item.iterationId : undefined,
    });
    setChildTitle('');
  };

  return (
    <div
      className={`card ${dropPos ? `drop-${dropPos}` : ''}`}
      style={{ borderLeftColor: TYPE_DEFS[item.type].color }}
      draggable
      onDragStart={(e) => startDrag(e, [item.id])}
      onDragEnd={endDrag}
      onDragOver={onDragOver}
      onContextMenu={onMenu}
      onDoubleClick={() => open(item.id)}
    >
      <div className="card-top">
        <TypeIcon type={item.type} size={14} />
        <span className="card-id">{item.id}</span>
        <button className="card-title" onClick={() => open(item.id)}>
          {item.title}
        </button>
        <button className="icon-btn card-more" aria-label="Actions" onClick={onMenu}>
          <Icon name="more" size={14} />
        </button>
      </div>
      <div className="card-fields">
        <AssigneePicker item={item} />
        {item.effort != null && (
          <div className="card-field">
            <span className="muted">Effort</span> {formatNumber(item.effort)}
          </div>
        )}
        {item.iterationId && (
          <div className="card-field">
            <span className="muted">Iteration</span> {iterationName(sprints, item.iterationId, projectName)}
          </div>
        )}
        {item.dueDate && (
          <div className={`card-field ${overdue ? 'warn' : ''}`}>
            <span className="muted">Due</span> {formatShortDate(item.dueDate)}
          </div>
        )}
        {item.blocked && <span className="badge badge-danger">Blocked</span>}
        <PullRequestBadges item={item} />
        <Tags tags={item.tags} max={3} />
      </div>
      {showChildren && (kids.length > 0 || childType) && (
        <div className="card-children">
          <div className="row gap-s">
            {kids.length > 0 && (
              <button className="link-btn small" onClick={() => onExpandedChange(!expanded)}>
                <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={10} /> {done}/{kids.length} {TYPE_DEFS[kids[0].type].shortName.toLowerCase()}s
              </button>
            )}
            {childType && (
              <button
                className="icon-btn card-add-child"
                title={`Add ${childType}`}
                onClick={() => {
                  setAdding(true);
                  onExpandedChange(true);
                }}
              >
                <Icon name="add" size={10} />
              </button>
            )}
          </div>
          {expanded &&
            kids.map((c) => {
              const closedState = TYPE_DEFS[c.type].states.find((s) => s.category === 'Completed')!.name;
              const openState = TYPE_DEFS[c.type].states[0].name;
              return (
                <label key={c.id} className="checklist-item">
                  <input type="checkbox" checked={c.state === closedState} onChange={(e) => api.updateWorkItem(c.id, { state: e.target.checked ? closedState : openState })} />
                  <button className={`link-btn ${c.state === closedState ? 'strike' : ''}`} onClick={() => open(c.id)}>
                    {c.title}
                  </button>
                </label>
              );
            })}
          {adding && (
            <input
              className="checklist-input"
              autoFocus
              placeholder={`New ${childType}`}
              value={childTitle}
              onChange={(e) => setChildTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void addChild();
                if (e.key === 'Escape') setAdding(false);
              }}
              onBlur={() => !childTitle && setAdding(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Open (or most recently updated) pull requests linked to a card. */
function PullRequestBadges({ item }: { item: WorkItem }) {
  const prs = (item.devLinks ?? []).filter((l) => l.kind === 'pullRequest');
  if (!prs.length) return null;
  const shown = prs.filter((l) => l.state === 'open');
  const list = shown.length ? shown : [...prs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 1);
  return (
    <div className="card-prs">
      {list.slice(0, 3).map((l) => (
        <a key={l.id} className="card-pr" href={l.url} target="_blank" rel="noopener noreferrer" title={`${l.repo}#${l.ref} ${l.title}`} onClick={(e) => e.stopPropagation()}>
          <Icon name="pullRequest" size={12} /> #{l.ref}
          <ChecksIcon checks={l.checks} />
          <PrStateBadge link={l} />
        </a>
      ))}
    </div>
  );
}
