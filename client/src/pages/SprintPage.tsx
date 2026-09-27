import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { formatDayMonth, formatShortDate } from '../../../shared/dates';
import { isClosed } from '../../../shared/process';
import { computeCapacity, computeSprintWork, defaultSprint, nextSprint, sprintTimeframe } from '../../../shared/sprints';
import type { Sprint, SprintCapacity } from '../../../shared/types';
import { api } from '../api';
import { EmptyState, ProgressBar, confirmDialog, useMenu } from '../components/common';
import { Icon } from '../components/Icon';
import { SprintDialog } from '../components/SprintDialog';
import { formatHours } from '../lib/format';
import { useLocalState, useMembersById, useSortedSprints, useToday } from '../lib/hooks';
import { toast, useStore } from '../store';
import { Analytics } from './sprint/Analytics';
import { CapacityView } from './sprint/Capacity';
import { SprintBacklog } from './sprint/SprintBacklog';
import { Taskboard } from './sprint/Taskboard';

const VIEWS = [
  { key: 'taskboard', label: 'Taskboard' },
  { key: 'backlog', label: 'Backlog' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'analytics', label: 'Analytics' },
] as const;

export function SprintPage() {
  const { sprintId, view } = useParams();
  const sprints = useSortedSprints();
  const today = useToday();
  const [creating, setCreating] = useState(false);

  if (!sprintId) {
    const s = defaultSprint(sprints, today);
    if (s) return <Navigate to={`/sprints/${s.id}/taskboard`} replace />;
    return (
      <div className="page">
        <div className="page-header">
          <div className="page-title-row">
            <h1>
              <Icon name="sprint" size={20} /> Sprints
            </h1>
          </div>
        </div>
        <EmptyState icon="sprint" title="No sprints yet">
          <p>Create a sprint to start planning work, tracking capacity and running a taskboard.</p>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="add" size={12} /> New sprint
          </button>
        </EmptyState>
        {creating && <SprintDialog onClose={() => setCreating(false)} />}
      </div>
    );
  }
  const sprint = sprints.find((s) => s.id === sprintId);
  if (!sprint) return <Navigate to="/sprints" replace />;
  if (!VIEWS.some((v) => v.key === view)) return <Navigate to={`/sprints/${sprint.id}/taskboard`} replace />;
  return <SprintShell key={sprint.id} sprint={sprint} view={view as (typeof VIEWS)[number]['key']} />;
}

function SprintShell({ sprint, view }: { sprint: Sprint; view: (typeof VIEWS)[number]['key'] }) {
  const sprints = useSortedSprints();
  const workingDays = useStore((s) => s.settings.workingDays);
  const capacity = useStore((s) => s.capacities.find((c) => c.sprintId === sprint.id));
  const navigate = useNavigate();
  const today = useToday();
  const menu = useMenu();
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showDetails, setShowDetails] = useLocalState('sprint.workDetails', { open: true });
  const [previewCapacity, setPreviewCapacity] = useState<SprintCapacity | null>(null);
  const tf = sprintTimeframe(sprint, today);
  const summary = computeCapacity(sprint, capacity, workingDays, today);

  const sprintMenu = sprints.map((s) => {
    const t = sprintTimeframe(s, today);
    return {
      label: `${s.name}${t === 'current' ? ' (Current)' : t === 'past' ? ' (Past)' : ''}`,
      checked: s.id === sprint.id,
      onClick: () => navigate(`/sprints/${s.id}/${view}`),
    };
  });

  const next = nextSprint(sprints, sprint);

  /** Move every unfinished backlog item (and its open tasks) out of this sprint. Done work stays for the record. */
  const moveUnfinished = async (target: Sprint | null) => {
    const items = useStore.getState().workItems.filter((w) => w.iterationId === sprint.id && !isClosed(w.type, w.state));
    const reqs = items.filter((w) => w.type !== 'Task');
    const reqIds = new Set(reqs.map((w) => w.id));
    // Open tasks whose parent isn't moving (no parent, or the parent is done) are moved too.
    const strayTasks = items.filter((w) => w.type === 'Task' && (w.parentId == null || !reqIds.has(w.parentId)));
    const ids = [...reqs, ...strayTasks].map((w) => w.id);
    if (!ids.length) return toast(`${sprint.name} has no unfinished work`);
    const where = target ? target.name : 'the backlog';
    const ok = await confirmDialog({
      title: `Move unfinished work to ${where}?`,
      message: `${reqs.length} unfinished backlog item${reqs.length === 1 ? '' : 's'}${strayTasks.length ? ` and ${strayTasks.length} other open task${strayTasks.length === 1 ? '' : 's'}` : ''} will move from ${sprint.name} to ${where}. Open tasks go with their backlog items. Finished work stays in ${sprint.name}.`,
      confirmLabel: 'Move',
    });
    if (!ok) return;
    await api.bulkUpdate(ids, { iterationId: target?.id ?? null });
    toast(`Moved unfinished work to ${where}`, 'success');
  };

  const deleteSprint = async () => {
    const others = sprints.filter((s) => s.id !== sprint.id);
    const next = others.find((s) => sprintTimeframe(s, today) !== 'past' && s.startDate && sprint.startDate && s.startDate > sprint.startDate);
    const ok = await confirmDialog({
      title: `Delete ${sprint.name}?`,
      message: `Unfinished and finished work in this sprint will be moved to ${next ? next.name : 'the backlog'}. Capacity settings for the sprint are removed.`,
      confirmLabel: 'Delete sprint',
      danger: true,
    });
    if (!ok) return;
    await api.deleteSprint(sprint.id, next?.id ?? null);
    toast(`${sprint.name} deleted`);
    navigate('/sprints');
  };

  const detailsVisible = showDetails.open && view !== 'analytics';

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <h1>
            <Icon name="sprint" size={20} />
            <button className="sprint-picker" onClick={(e) => menu.openAt(e, sprintMenu)}>
              {sprint.name} <Icon name="chevronDown" size={14} />
            </button>
          </h1>
          <span className="sprint-dates muted">
            {sprint.startDate ? `${formatDayMonth(sprint.startDate)} – ${formatShortDate(sprint.finishDate)}` : 'No dates set'}
            {tf === 'current' && ` · ${summary.remainingWorkingDays} work day${summary.remainingWorkingDays === 1 ? '' : 's'} remaining`}
            {tf === 'future' && ' · Not started'}
            {tf === 'past' && ' · Completed'}
          </span>
          {tf === 'current' && <span className="badge badge-current">Current</span>}
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={() => setCreating(true)}>
            <Icon name="add" size={14} /> New sprint
          </button>
          <button
            className="icon-btn"
            aria-label="Sprint actions"
            onClick={(e) =>
              menu.openAt(e, [
                {
                  label: next ? `Move unfinished work to ${next.name}` : 'Move unfinished work to next sprint (none planned yet)',
                  icon: 'sprint',
                  disabled: !next,
                  onClick: () => next && void moveUnfinished(next),
                },
                { label: 'Move unfinished work to backlog', icon: 'backlog', onClick: () => void moveUnfinished(null) },
                { divider: true },
                { label: 'Edit sprint', icon: 'edit', onClick: () => setEditing(true) },
                { label: 'Delete sprint', icon: 'trash', danger: true, onClick: deleteSprint },
              ])
            }
          >
            <Icon name="more" />
          </button>
        </div>
        {sprint.goal && (
          <div className="sprint-goal">
            <Icon name="target" size={14} /> <span>{sprint.goal}</span>
          </div>
        )}
        <div className="toolbar">
          <div className="tabs page-tabs">
            {VIEWS.map((v) => (
              <Link key={v.key} className={v.key === view ? 'active' : ''} to={`/sprints/${sprint.id}/${v.key}`}>
                {v.label}
              </Link>
            ))}
          </div>
          <div className="spacer" />
          {view !== 'analytics' && (
            <button className={`btn btn-ghost ${showDetails.open ? 'active' : ''}`} onClick={() => setShowDetails({ open: !showDetails.open })}>
              <Icon name="pane" size={14} /> Work details
            </button>
          )}
        </div>
      </div>
      <div className="page-body split">
        <div className="sprint-main">
          {view === 'taskboard' && <Taskboard sprint={sprint} />}
          {view === 'backlog' && <SprintBacklog sprint={sprint} />}
          {view === 'capacity' && <CapacityView sprint={sprint} onPreview={setPreviewCapacity} />}
          {view === 'analytics' && <Analytics sprint={sprint} />}
        </div>
        {detailsVisible && <WorkDetails sprint={sprint} capacity={(view === 'capacity' && previewCapacity) || capacity} />}
      </div>
      {editing && <SprintDialog sprint={sprint} onClose={() => setEditing(false)} />}
      {creating && <SprintDialog onClose={() => setCreating(false)} onSaved={(s) => navigate(`/sprints/${s.id}/capacity`)} />}
      {menu.element}
    </div>
  );
}

/** Remaining work versus remaining capacity, like Azure DevOps' "Work details" panel. */
export function WorkDetails({ sprint, capacity }: { sprint: Sprint; capacity: SprintCapacity | undefined }) {
  const items = useStore((s) => s.workItems);
  const workingDays = useStore((s) => s.settings.workingDays);
  const members = useMembersById();
  const today = useToday();
  const cap = computeCapacity(sprint, capacity, workingDays, today);
  const work = useMemo(() => computeSprintWork(items, sprint.id), [items, sprint.id]);
  const effort = useMemo(() => {
    const reqs = items.filter((w) => w.iterationId === sprint.id && (w.type === 'Product Backlog Item' || w.type === 'Bug') && w.state !== 'Removed');
    return {
      total: reqs.reduce((s, w) => s + (w.effort ?? 0), 0),
      done: reqs.filter((w) => w.state === 'Done').reduce((s, w) => s + (w.effort ?? 0), 0),
    };
  }, [items, sprint.id]);
  const activities = [...new Set([...Object.keys(cap.byActivity), ...Object.keys(work.byActivity)])].sort();
  const people = [...new Set([...cap.members.map((m) => m.memberId), ...Object.keys(work.byMember)])];
  const hasCapacity = cap.members.length > 0;

  return (
    <aside className="side-pane work-details">
      <div className="side-pane-header">
        <h3>Work details</h3>
      </div>
      <div className="wd-section">
        <h4>Effort</h4>
        <ProgressBar value={effort.done} max={effort.total} over={false} label={<span>{effort.done} of {effort.total} points done</span>} />
      </div>
      <div className="wd-section">
        <h4>Team</h4>
        <ProgressBar
          value={work.total}
          max={cap.remainingCapacity}
          label={
            <span>
              {formatHours(work.total)} of {hasCapacity ? formatHours(cap.remainingCapacity) : 'no capacity set'}
              {hasCapacity && work.total > cap.remainingCapacity && <span className="warn"> · {formatHours(work.total - cap.remainingCapacity)} over</span>}
            </span>
          }
        />
        {!hasCapacity && (
          <Link className="small" to={`/sprints/${sprint.id}/capacity`}>
            Set capacity
          </Link>
        )}
      </div>
      {activities.length > 0 && (
        <div className="wd-section">
          <h4>Work by: Activity</h4>
          {activities.map((a) => (
            <ProgressBar key={a} value={work.byActivity[a] ?? 0} max={cap.byActivity[a] ?? 0} label={<span>{a} <span className="muted">{formatHours(work.byActivity[a] ?? 0)} / {formatHours(cap.byActivity[a] ?? 0)}</span></span>} />
          ))}
        </div>
      )}
      {people.length > 0 && (
        <div className="wd-section">
          <h4>Work by: Assigned To</h4>
          {people.map((id) => {
            const c = cap.members.find((m) => m.memberId === id)?.remainingCapacity ?? 0;
            const w = work.byMember[id] ?? 0;
            return <ProgressBar key={id || 'none'} value={w} max={c} label={<span>{id ? (members.get(id)?.name ?? 'Former member') : 'Unassigned'} <span className="muted">{formatHours(w)} / {formatHours(c)}</span></span>} />;
          })}
        </div>
      )}
      <div className="muted small pad-x">Capacity counts working days from today to the sprint end, minus days off. Work counts remaining hours on unfinished leaf items.</div>
    </aside>
  );
}
