import { useMemo, useState } from 'react';
import { TASK_COLUMNS, TYPE_DEFS } from '../../../../shared/process';
import type { Sprint, WorkItem } from '../../../../shared/types';
import { api } from '../../api';
import { Avatar, EmptyState, Person, StateBadge, useMenu } from '../../components/common';
import { Icon, TypeIcon } from '../../components/Icon';
import { useWorkItemDialog } from '../../components/WorkItemForm';
import { useItemMenu } from '../../lib/actions';
import { draggedIds, dropPosition, endDrag, startDrag } from '../../lib/dnd';
import { formatHours, formatNumber } from '../../lib/format';
import { useItemsById, useLocalState, useMembersById } from '../../lib/hooks';
import { useStore } from '../../store';

interface Lane {
  key: string;
  /** Backlog item for story lanes; undefined for the unparented lane and people lanes. */
  parent?: WorkItem;
  memberId?: string | null;
  label: string;
  tasks: WorkItem[];
}

export function Taskboard({ sprint }: { sprint: Sprint }) {
  const items = useStore((s) => s.workItems);
  const members = useStore((s) => s.members);
  const membersById = useMembersById();
  const itemsById = useItemsById();
  const { open, openNew } = useWorkItemDialog();
  const menu = useMenu();
  const itemMenu = useItemMenu();
  const [opts, setOpts] = useLocalState('taskboard', { groupBy: 'stories' as 'stories' | 'people', person: '__all__' });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drop, setDrop] = useState<{ lane: string; column: string; id: number | null; pos: 'before' | 'after' } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');

  const { lanes, reqs } = useMemo(() => {
    const inSprint = items.filter((w) => w.iterationId === sprint.id && w.state !== 'Removed').sort((a, b) => a.stackRank - b.stackRank);
    const reqs = inSprint.filter((w) => w.type === 'Product Backlog Item' || w.type === 'Bug');
    let tasks = inSprint.filter((w) => w.type === 'Task');
    if (opts.person !== '__all__') tasks = tasks.filter((t) => (t.assignedTo ?? '') === opts.person);
    const lanes: Lane[] = [];
    if (opts.groupBy === 'people') {
      const ids = [...new Set([...members.filter((m) => m.active).map((m) => m.id), ...tasks.map((t) => t.assignedTo ?? '')])];
      for (const id of ids) {
        if (opts.person !== '__all__' && id !== opts.person) continue;
        const list = tasks.filter((t) => (t.assignedTo ?? '') === id);
        if (!list.length && id === '') continue;
        lanes.push({ key: `p:${id}`, memberId: id || null, label: id ? (membersById.get(id)?.name ?? 'Former member') : 'Unassigned', tasks: list });
      }
      return { lanes, reqs };
    }
    // Parents of in-sprint tasks that live in other iterations still get a lane.
    const parentIds = new Set(reqs.map((r) => r.id));
    const extra = tasks.map((t) => (t.parentId != null ? itemsById.get(t.parentId) : undefined)).filter((p): p is WorkItem => !!p && !parentIds.has(p.id));
    for (const p of [...reqs, ...new Map(extra.map((e) => [e.id, e])).values()]) {
      lanes.push({ key: `s:${p.id}`, parent: p, label: p.title, tasks: tasks.filter((t) => t.parentId === p.id) });
    }
    const orphans = tasks.filter((t) => t.parentId == null || !itemsById.has(t.parentId) || !lanes.some((l) => l.parent?.id === t.parentId));
    if (orphans.length) lanes.push({ key: 'unparented', label: 'Unparented', tasks: orphans });
    return { lanes, reqs };
  }, [items, sprint.id, opts, members, membersById, itemsById]);

  const onDrop = async (lane: Lane, column: string) => {
    const target = drop;
    setDrop(null);
    const ids = draggedIds();
    endDrag();
    for (const id of ids) {
      const task = itemsById.get(id);
      if (!task || task.type !== 'Task') continue;
      const input: Parameters<typeof api.moveWorkItem>[1] = {};
      if (task.state !== column) input.state = column;
      if (lane.parent && task.parentId !== lane.parent.id) input.parentId = lane.parent.id;
      if (lane.key === 'unparented' && task.parentId != null) input.parentId = null;
      if (lane.memberId !== undefined && (task.assignedTo ?? null) !== lane.memberId) input.assignedTo = lane.memberId;
      if (target?.id != null && target.id !== id) input[target.pos === 'before' ? 'beforeId' : 'afterId'] = target.id;
      if (Object.keys(input).length) await api.moveWorkItem(id, input);
    }
  };

  const addTask = async (lane: Lane) => {
    if (!newTitle.trim()) return;
    await api.createWorkItem('Task', {
      title: newTitle.trim(),
      parentId: lane.parent?.id ?? null,
      iterationId: sprint.id,
      assignedTo: lane.memberId !== undefined ? lane.memberId : (lane.parent?.assignedTo ?? null),
    });
    setNewTitle('');
  };

  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setCollapsed(next);
  };

  return (
    <div className="sprint-view">
      <div className="view-toolbar">
        <button className="btn btn-primary-ghost" onClick={(e) => menu.openAt(e, [
          { label: 'Product Backlog Item', onClick: () => openNew('Product Backlog Item', { iterationId: sprint.id }) },
          { label: 'Bug', onClick: () => openNew('Bug', { iterationId: sprint.id }) },
          { label: 'Task (unparented)', onClick: () => openNew('Task', { iterationId: sprint.id }) },
        ])}>
          <Icon name="add" size={14} /> New work item
        </button>
        <div className="spacer" />
        <label className="inline-label">
          Person
          <select value={opts.person} onChange={(e) => setOpts({ ...opts, person: e.target.value })}>
            <option value="__all__">All</option>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-label">
          Group by
          <select value={opts.groupBy} onChange={(e) => setOpts({ ...opts, groupBy: e.target.value as 'stories' | 'people' })}>
            <option value="stories">Backlog items</option>
            <option value="people">People</option>
          </select>
        </label>
        <button className="icon-btn" title="Expand all" onClick={() => setCollapsed(new Set())}>
          <Icon name="expandAll" />
        </button>
        <button className="icon-btn" title="Collapse all" onClick={() => setCollapsed(new Set(lanes.map((l) => l.key)))}>
          <Icon name="collapseAll" />
        </button>
      </div>
      {lanes.length === 0 ? (
        <EmptyState icon="board" title="No work in this sprint yet">
          Plan backlog items into this sprint from the Backlogs page (drag onto the planning pane) or create one here.
        </EmptyState>
      ) : (
        <div className="taskboard">
          <div className="taskboard-head">
            <div className="tb-lane-head">{opts.groupBy === 'people' ? 'Person' : 'Backlog item'}</div>
            {TASK_COLUMNS.map((c) => (
              <div key={c} className="tb-col-head">
                {c} <span className="count-pill">{lanes.reduce((s, l) => s + l.tasks.filter((t) => t.state === c).length, 0)}</span>
              </div>
            ))}
          </div>
          {lanes.map((lane) => {
            const isCollapsed = collapsed.has(lane.key);
            const remaining = lane.tasks.filter((t) => t.state !== 'Done').reduce((s, t) => s + (t.remainingWork ?? 0), 0);
            return (
              <div key={lane.key} className={`tb-lane ${isCollapsed ? 'collapsed' : ''}`}>
                <div className="tb-lane-header">
                  <button className="expander" onClick={() => toggle(lane.key)} aria-label={isCollapsed ? 'Expand' : 'Collapse'}>
                    <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />
                  </button>
                  {lane.parent ? (
                    <div className="tb-parent-card" style={{ borderLeftColor: TYPE_DEFS[lane.parent.type].color }} onContextMenu={(e) => menu.openAt(e, itemMenu.build([lane.parent!]))}>
                      <div className="card-top">
                        <TypeIcon type={lane.parent.type} size={14} />
                        <span className="card-id">{lane.parent.id}</span>
                        <button className="card-title" onClick={() => open(lane.parent!.id)}>
                          {lane.parent.title}
                        </button>
                      </div>
                      {!isCollapsed && (
                        <div className="card-fields">
                          <Person id={lane.parent.assignedTo} size={18} />
                          <select
                            className="state-select"
                            value={lane.parent.state}
                            onChange={(e) => api.updateWorkItem(lane.parent!.id, { state: e.target.value })}
                            aria-label="State"
                          >
                            {TYPE_DEFS[lane.parent.type].states.map((s) => (
                              <option key={s.name}>{s.name}</option>
                            ))}
                          </select>
                          <div className="card-field muted small">
                            {lane.parent.effort != null && <>Effort {formatNumber(lane.parent.effort)} · </>}
                            {formatHours(remaining) || '0 h'} remaining
                            {lane.parent.iterationId !== sprint.id && ' · other iteration'}
                          </div>
                        </div>
                      )}
                      {isCollapsed && <StateBadge type={lane.parent.type} state={lane.parent.state} />}
                    </div>
                  ) : (
                    <div className="tb-lane-label">
                      {lane.memberId !== undefined && <Avatar member={lane.memberId ? membersById.get(lane.memberId) : null} size={24} />}
                      <strong>{lane.label}</strong>
                      <span className="muted small">{formatHours(remaining) || '0 h'} remaining</span>
                    </div>
                  )}
                  <button
                    className="icon-btn tb-add"
                    title="Add task"
                    onClick={() => {
                      setAdding(lane.key);
                      setNewTitle('');
                      if (isCollapsed) toggle(lane.key);
                    }}
                  >
                    <Icon name="add" size={14} />
                  </button>
                </div>
                {isCollapsed ? (
                  TASK_COLUMNS.map((c) => (
                    <div key={c} className="tb-cell collapsed-cell muted small">
                      {lane.tasks.filter((t) => t.state === c).length || ''}
                    </div>
                  ))
                ) : (
                  TASK_COLUMNS.map((column, idx) => {
                    const cellTasks = lane.tasks.filter((t) => t.state === column);
                    const active = drop?.lane === lane.key && drop.column === column;
                    return (
                      <div
                        key={column}
                        className={`tb-cell ${active ? 'drop-active' : ''}`}
                        onDragOver={(e) => {
                          const ids = draggedIds();
                          if (!ids.length || !ids.every((id) => itemsById.get(id)?.type === 'Task')) return;
                          e.preventDefault();
                          if (!(e.target as HTMLElement).closest('.task-card') && (!active || drop?.id !== null)) setDrop({ lane: lane.key, column, id: null, pos: 'after' });
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          void onDrop(lane, column);
                        }}
                      >
                        {idx === 0 && adding === lane.key && (
                          <div className="task-card task-new">
                            <textarea
                              autoFocus
                              placeholder="New task title, Enter to add"
                              value={newTitle}
                              onChange={(e) => setNewTitle(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void addTask(lane);
                                }
                                if (e.key === 'Escape') setAdding(null);
                              }}
                              onBlur={() => !newTitle && setAdding(null)}
                            />
                          </div>
                        )}
                        {cellTasks.map((t) => (
                          <TaskCard
                            key={t.id}
                            task={t}
                            showParent={opts.groupBy === 'people'}
                            dropPos={drop?.id === t.id ? drop.pos : null}
                            onDragOver={(e) => {
                              if (!draggedIds().length || draggedIds().includes(t.id)) return;
                              e.preventDefault();
                              const pos = dropPosition(e);
                              if (drop?.id !== t.id || drop.pos !== pos) setDrop({ lane: lane.key, column, id: t.id, pos });
                            }}
                            onMenu={(e) => menu.openAt(e, itemMenu.build([t]))}
                          />
                        ))}
                      </div>
                    );
                  })
                )}
              </div>
            );
          })}
          {opts.groupBy === 'stories' && reqs.length === 0 && <div className="muted pad">No backlog items in this sprint.</div>}
        </div>
      )}
      {menu.element}
      {itemMenu.element}
    </div>
  );
}

function TaskCard({
  task,
  showParent,
  dropPos,
  onDragOver,
  onMenu,
}: {
  task: WorkItem;
  showParent: boolean;
  dropPos: 'before' | 'after' | null;
  onDragOver: (e: React.DragEvent) => void;
  onMenu: (e: React.MouseEvent) => void;
}) {
  const { open } = useWorkItemDialog();
  const itemsById = useItemsById();
  const members = useStore((s) => s.members);
  const [editingHours, setEditingHours] = useState(false);
  const menu = useMenu();
  const parent = task.parentId != null ? itemsById.get(task.parentId) : undefined;
  return (
    <div
      className={`task-card ${task.blocked ? 'blocked' : ''} ${dropPos ? `drop-${dropPos}` : ''}`}
      draggable
      onDragStart={(e) => startDrag(e, [task.id])}
      onDragEnd={endDrag}
      onDragOver={onDragOver}
      onContextMenu={onMenu}
      onDoubleClick={() => open(task.id)}
    >
      <div className="card-top">
        <span className="card-id">{task.id}</span>
        <button className="card-title" onClick={() => open(task.id)}>
          {task.title}
        </button>
        <button className="icon-btn card-more" aria-label="Actions" onClick={onMenu}>
          <Icon name="more" size={14} />
        </button>
      </div>
      {showParent && parent && (
        <div className="muted small ellipsis">
          <TypeIcon type={parent.type} size={12} /> {parent.title}
        </div>
      )}
      <div className="task-card-footer">
        <button
          className="person-btn"
          onClick={(e) =>
            menu.openAt(e, [
              { label: 'Unassigned', checked: !task.assignedTo, onClick: () => api.updateWorkItem(task.id, { assignedTo: null }) },
              ...members.filter((m) => m.active).map((m) => ({ label: m.name, checked: task.assignedTo === m.id, onClick: () => api.updateWorkItem(task.id, { assignedTo: m.id }) })),
            ])
          }
        >
          <Person id={task.assignedTo} size={18} />
        </button>
        <span className="task-activity muted small">{task.activity}</span>
        {task.blocked && <span className="badge badge-danger">Blocked</span>}
        {editingHours ? (
          <input
            className="hours-input"
            type="number"
            min={0}
            step={0.5}
            autoFocus
            defaultValue={task.remainingWork ?? ''}
            aria-label="Remaining work"
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditingHours(false);
            }}
            onBlur={(e) => {
              setEditingHours(false);
              const v = e.target.value === '' ? null : Number(e.target.value);
              if ((v === null || (Number.isFinite(v) && v >= 0)) && v !== task.remainingWork) void api.updateWorkItem(task.id, { remainingWork: v });
            }}
          />
        ) : (
          <button className="hours" title="Remaining work (click to edit)" onClick={() => setEditingHours(true)}>
            {task.remainingWork != null ? formatHours(task.remainingWork) : '— h'}
          </button>
        )}
      </div>
      {menu.element}
    </div>
  );
}
