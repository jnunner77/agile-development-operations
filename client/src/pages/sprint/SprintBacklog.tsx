import { useMemo, useState } from 'react';
import type { WorkItemType } from '../../../../shared/process';
import type { Sprint, WorkItem } from '../../../../shared/types';
import { api } from '../../api';
import { EmptyState, Person, StateBadge, Tags, useMenu } from '../../components/common';
import { Icon, TypeIcon } from '../../components/Icon';
import { useWorkItemDialog } from '../../components/WorkItemForm';
import { useItemMenu } from '../../lib/actions';
import { draggedIds, dropPosition, endDrag, startDrag } from '../../lib/dnd';
import { formatHours, formatNumber } from '../../lib/format';
import { rollup, useChildrenMap, useItemsById } from '../../lib/hooks';
import { useStore } from '../../store';

const REQ_TYPES: WorkItemType[] = ['Product Backlog Item', 'Bug'];

export function SprintBacklog({ sprint }: { sprint: Sprint }) {
  const items = useStore((s) => s.workItems);
  const itemsById = useItemsById();
  const children = useChildrenMap();
  const { open } = useWorkItemDialog();
  const menu = useMenu();
  const itemMenu = useItemMenu();
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  const [addType, setAddType] = useState<WorkItemType>('Product Backlog Item');
  const [title, setTitle] = useState('');
  const [taskFor, setTaskFor] = useState<number | null>(null);
  const [taskTitle, setTaskTitle] = useState('');
  const [drop, setDrop] = useState<{ id: number; pos: 'before' | 'after' | 'into' } | null>(null);

  const reqs = useMemo(
    () => items.filter((w) => w.iterationId === sprint.id && REQ_TYPES.includes(w.type) && w.state !== 'Removed').sort((a, b) => a.stackRank - b.stackRank),
    [items, sprint.id],
  );
  const unparentedTasks = useMemo(
    () => items.filter((w) => w.iterationId === sprint.id && w.type === 'Task' && w.state !== 'Removed' && (w.parentId == null || !reqs.some((r) => r.id === w.parentId))),
    [items, sprint.id, reqs],
  );

  const tasksOf = (id: number) => (children.get(id) ?? []).filter((c) => c.type === 'Task' && c.state !== 'Removed');

  const addItem = async () => {
    if (!title.trim()) return;
    await api.createWorkItem(addType, { title: title.trim(), iterationId: sprint.id, position: 'bottom' });
    setTitle('');
  };

  const addTask = async (parent: WorkItem) => {
    if (!taskTitle.trim()) return;
    await api.createWorkItem('Task', { title: taskTitle.trim(), parentId: parent.id, iterationId: sprint.id, assignedTo: parent.assignedTo });
    setTaskTitle('');
  };

  const onDrop = async (target: WorkItem) => {
    const t = drop;
    setDrop(null);
    const ids = draggedIds();
    endDrag();
    if (!t) return;
    for (const id of ids) {
      const w = itemsById.get(id);
      if (!w) continue;
      if (t.pos === 'into') await api.moveWorkItem(id, { parentId: target.id, iterationId: sprint.id });
      else if (w.type === 'Task') await api.moveWorkItem(id, { parentId: target.parentId, [t.pos === 'before' ? 'beforeId' : 'afterId']: target.id });
      else await api.moveWorkItem(id, { [t.pos === 'before' ? 'beforeId' : 'afterId']: target.id });
    }
  };

  const dragOver = (e: React.DragEvent, target: WorkItem) => {
    const ids = draggedIds();
    if (!ids.length || ids.includes(target.id)) return;
    const dragged = ids.map((id) => itemsById.get(id)).filter((w): w is WorkItem => !!w);
    const isTask = dragged.every((w) => w.type === 'Task');
    const isReq = dragged.every((w) => REQ_TYPES.includes(w.type));
    let pos: 'before' | 'after' | 'into' | null = null;
    if (isReq && REQ_TYPES.includes(target.type)) pos = dropPosition(e);
    else if (isTask && REQ_TYPES.includes(target.type)) pos = 'into';
    else if (isTask && target.type === 'Task') pos = dropPosition(e);
    if (!pos) return;
    e.preventDefault();
    if (drop?.id !== target.id || drop.pos !== pos) setDrop({ id: target.id, pos });
  };

  const row = (w: WorkItem, depth: number, hasKids: boolean) => {
    const r = rollup(w, children);
    return (
      <tr
        key={w.id}
        className={`grid-row ${depth ? 'row-child' : 'row-level'} ${drop?.id === w.id ? `drop-${drop.pos}` : ''}`}
        draggable
        onDragStart={(e) => startDrag(e, [w.id])}
        onDragEnd={() => {
          endDrag();
          setDrop(null);
        }}
        onDragOver={(e) => dragOver(e, w)}
        onDragLeave={() => setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          void onDrop(w);
        }}
        onDoubleClick={() => open(w.id)}
        onContextMenu={(e) => menu.openAt(e, itemMenu.build([w], { reorderWithin: depth ? undefined : reqs, onAddChild: (p) => setTaskFor(p.id) }))}
      >
        <td className="col-drag">
          <Icon name="drag" size={12} />
        </td>
        <td className="col-order muted">{depth ? '' : reqs.indexOf(w) + 1}</td>
        <td className="col-title">
          <div className="title-cell" style={{ paddingLeft: depth * 20 }}>
            {hasKids ? (
              <button
                className="expander"
                onClick={() => {
                  const next = new Set(collapsed);
                  if (next.has(w.id)) next.delete(w.id);
                  else next.add(w.id);
                  setCollapsed(next);
                }}
              >
                <Icon name={collapsed.has(w.id) ? 'chevronRight' : 'chevronDown'} size={12} />
              </button>
            ) : (
              <span className="expander-spacer" />
            )}
            <TypeIcon type={w.type} />
            <button className="title-link" title={w.title} onClick={() => open(w.id)}>
              {w.title}
            </button>
            {w.blocked && <span className="badge badge-danger">Blocked</span>}
            {!depth && (
              <button
                className="icon-btn row-add"
                title="Add task"
                onClick={() => {
                  setTaskFor(w.id);
                  setTaskTitle('');
                  const next = new Set(collapsed);
                  next.delete(w.id);
                  setCollapsed(next);
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
        <td>
          <Person id={w.assignedTo} />
        </td>
        <td className="num">{formatNumber(w.effort)}</td>
        <td className="num">{r.hasChildren ? formatHours(r.remaining) : formatHours(w.remainingWork)}</td>
        <td>{w.activity ?? ''}</td>
        <td>
          <Tags tags={w.tags} max={2} />
        </td>
        <td className="col-actions">
          <button className="icon-btn row-more" aria-label="Actions" onClick={(e) => menu.openAt(e, itemMenu.build([w], { reorderWithin: depth ? undefined : reqs, onAddChild: (p) => setTaskFor(p.id) }))}>
            <Icon name="more" size={14} />
          </button>
        </td>
      </tr>
    );
  };

  return (
    <div className="sprint-view">
      <div className="view-toolbar">
        <button className="btn btn-primary-ghost" onClick={() => setAdding(!adding)}>
          <Icon name="add" size={14} /> New work item
        </button>
        <div className="spacer" />
        <button className="icon-btn" title="Expand all" onClick={() => setCollapsed(new Set())}>
          <Icon name="expandAll" />
        </button>
        <button className="icon-btn" title="Collapse all" onClick={() => setCollapsed(new Set(reqs.map((r) => r.id)))}>
          <Icon name="collapseAll" />
        </button>
      </div>
      {adding && (
        <div className="add-panel">
          <select value={addType} onChange={(e) => setAddType(e.target.value as WorkItemType)} aria-label="Type">
            {REQ_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <TypeIcon type={addType} />
          <input
            autoFocus
            placeholder="Enter title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addItem();
              if (e.key === 'Escape') setAdding(false);
            }}
          />
          <button className="btn btn-primary" onClick={addItem} disabled={!title.trim()}>
            Add
          </button>
        </div>
      )}
      {reqs.length === 0 && unparentedTasks.length === 0 ? (
        <EmptyState icon="backlog" title="This sprint has no work yet">
          Add items here, or drag them from the product backlog onto this sprint in the planning pane.
        </EmptyState>
      ) : (
        <div className="grid-wrap">
          <table className="grid backlog-grid">
            <thead>
              <tr>
                <th className="col-drag" />
                <th className="col-order">Order</th>
                <th className="col-title">Title</th>
                <th>State</th>
                <th>Assigned To</th>
                <th>Effort</th>
                <th>Remaining Work</th>
                <th>Activity</th>
                <th>Tags</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {reqs.map((req) => {
                const tasks = tasksOf(req.id);
                return [
                  row(req, 0, tasks.length > 0),
                  ...(collapsed.has(req.id) ? [] : tasks.map((t) => row(t, 1, false))),
                  taskFor === req.id && (
                    <tr key={`add-${req.id}`} className="row-add-child">
                      <td />
                      <td />
                      <td colSpan={8}>
                        <div className="inline-add" style={{ paddingLeft: 44 }}>
                          <TypeIcon type="Task" />
                          <input
                            autoFocus
                            placeholder="New task title, Enter to add"
                            value={taskTitle}
                            onChange={(e) => setTaskTitle(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void addTask(req);
                              if (e.key === 'Escape') setTaskFor(null);
                            }}
                            onBlur={() => !taskTitle && setTaskFor(null)}
                          />
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
              {unparentedTasks.length > 0 && (
                <tr className="row-header">
                  <td />
                  <td colSpan={9}>Unparented tasks</td>
                </tr>
              )}
              {unparentedTasks.map((t) => row(t, 1, false))}
            </tbody>
          </table>
        </div>
      )}
      {menu.element}
      {itemMenu.element}
    </div>
  );
}
