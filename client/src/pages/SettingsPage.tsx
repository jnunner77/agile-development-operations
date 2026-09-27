import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { formatShortDate, workingDaysBetween } from '../../../shared/dates';
import { sprintTimeframe } from '../../../shared/sprints';
import type { Member, SnapshotMeta, Sprint } from '../../../shared/types';
import { api } from '../api';
import { Avatar, EmptyState, Modal, StateBadge, confirmDialog } from '../components/common';
import { Icon, TypeIcon } from '../components/Icon';
import { SprintDialog } from '../components/SprintDialog';
import { SecuritySettings } from './SecuritySettings';
import { IntegrationsSettings } from './IntegrationsSettings';
import { formatBytes, formatDateTime, timeAgo } from '../lib/format';
import { useSortedSprints, useToday } from '../lib/hooks';
import { toast, useStore } from '../store';

const TABS = [
  { key: 'general', label: 'General', icon: 'settings' },
  { key: 'team', label: 'Team members', icon: 'people' },
  { key: 'sprints', label: 'Sprints', icon: 'sprint' },
  { key: 'backups', label: 'Snapshots & backups', icon: 'backup' },
  { key: 'recycle-bin', label: 'Recycle bin', icon: 'trash' },
  { key: 'authentication', label: 'Authentication', icon: 'lock', adminOnly: true },
  { key: 'integrations', label: 'Integrations', icon: 'github', adminOnly: true },
];

/** With sign-in on, only administrators can change project settings. */
export function useCanAdminister() {
  return useStore((s) => !s.auth?.enabled || !!s.auth.user?.isAdmin);
}

export function SettingsPage() {
  const { tab } = useParams();
  const canAdminister = useCanAdminister();
  const tabs = TABS.filter((t) => !t.adminOnly || canAdminister);
  if (!tabs.some((t) => t.key === tab)) return <Navigate to="/settings/general" replace />;
  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <h1>
            <Icon name="settings" size={20} /> Project settings
          </h1>
        </div>
      </div>
      <div className="page-body settings">
        <nav className="settings-nav">
          {tabs.map((t) => (
            <Link key={t.key} to={`/settings/${t.key}`} className={t.key === tab ? 'active' : ''}>
              <Icon name={t.icon} size={16} /> {t.label}
            </Link>
          ))}
        </nav>
        <div className="settings-content">
          {!canAdminister && (
            <div className="callout">
              <Icon name="lock" size={14} /> Only administrators can change project settings.
            </div>
          )}
          {tab === 'general' && <GeneralSettings />}
          {tab === 'team' && <TeamSettings />}
          {tab === 'sprints' && <SprintSettings />}
          {tab === 'backups' && <BackupSettings />}
          {tab === 'recycle-bin' && <RecycleBin />}
          {tab === 'authentication' && <SecuritySettings />}
          {tab === 'integrations' && <IntegrationsSettings />}
        </div>
      </div>
    </div>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function GeneralSettings() {
  const settings = useStore((s) => s.settings);
  const [projectName, setProjectName] = useState(settings.projectName);
  const [teamName, setTeamName] = useState(settings.teamName);
  const [workingDays, setWorkingDays] = useState(settings.workingDays);
  const [areas, setAreas] = useState(settings.areaPaths.join('\n'));
  const areaList = areas
    .split('\n')
    .map((a) => a.trim())
    .filter(Boolean);
  const dirty =
    projectName !== settings.projectName ||
    teamName !== settings.teamName ||
    JSON.stringify([...workingDays].sort()) !== JSON.stringify(settings.workingDays) ||
    JSON.stringify(areaList) !== JSON.stringify(settings.areaPaths);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.updateSettings({ projectName: projectName.trim(), teamName: teamName.trim(), workingDays, areaPaths: areaList });
    toast('Settings saved', 'success');
  };

  return (
    <form className="form settings-card" onSubmit={save}>
      <h2>General</h2>
      <label>
        Project name
        <input value={projectName} onChange={(e) => setProjectName(e.target.value)} required maxLength={128} />
      </label>
      <label>
        Team name
        <input value={teamName} onChange={(e) => setTeamName(e.target.value)} required maxLength={128} />
      </label>
      <fieldset>
        <legend>Working days</legend>
        <div className="muted small">Used for capacity, burndown and sprint length calculations.</div>
        <div className="row gap wrap">
          {DAYS.map((d, i) => (
            <label key={d} className="check-row">
              <input
                type="checkbox"
                checked={workingDays.includes(i)}
                onChange={(e) => setWorkingDays(e.target.checked ? [...workingDays, i].sort() : workingDays.filter((x) => x !== i))}
              />
              {d}
            </label>
          ))}
        </div>
      </fieldset>
      <label>
        Area paths <span className="muted small">(one per line)</span>
        <textarea value={areas} onChange={(e) => setAreas(e.target.value)} rows={5} />
      </label>
      <div className="row gap">
        <button className="btn btn-primary" type="submit" disabled={!dirty || !workingDays.length || !areaList.length}>
          Save
        </button>
      </div>
    </form>
  );
}

function TeamSettings() {
  const members = useStore((s) => s.members);
  const items = useStore((s) => s.workItems);
  const [editing, setEditing] = useState<Member | 'new' | null>(null);
  const canAdminister = useCanAdminister();
  return (
    <div className="settings-card">
      <div className="row between">
        <h2>Team members</h2>
        <button className="btn btn-primary" onClick={() => setEditing('new')} disabled={!canAdminister}>
          <Icon name="add" size={12} /> Add member
        </button>
      </div>
      <p className="muted small">Team members can be assigned work and planned in sprint capacity. Inactive members keep their history but are hidden from pickers.</p>
      {members.length === 0 ? (
        <EmptyState icon="people" title="No team members yet" />
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Email</th>
              <th>Status</th>
              <th>Open items</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className="grid-row">
                <td>
                  <span className="person">
                    <Avatar member={m} size={26} /> {m.name}
                  </span>
                </td>
                <td className="muted">{m.username}</td>
                <td className="muted">{m.email}</td>
                <td>{m.active ? 'Active' : <span className="muted">Inactive</span>}</td>
                <td className="num">{items.filter((w) => w.assignedTo === m.id && w.state !== 'Done' && w.state !== 'Removed').length}</td>
                <td className="col-actions">
                  <button className="icon-btn" aria-label={`Edit ${m.name}`} onClick={() => setEditing(m)} disabled={!canAdminister}>
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    className="icon-btn"
                    aria-label={`Remove ${m.name}`}
                    disabled={!canAdminister}
                    onClick={async () => {
                      const ok = await confirmDialog({
                        title: `Remove ${m.name}?`,
                        message: 'Their work items become unassigned and they are removed from sprint capacity. Consider marking them inactive instead to keep assignments.',
                        confirmLabel: 'Remove',
                        danger: true,
                      });
                      if (ok) await api.deleteMember(m.id);
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && <MemberDialog member={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MemberDialog({ member, onClose }: { member?: Member; onClose: () => void }) {
  const [name, setName] = useState(member?.name ?? '');
  const [username, setUsername] = useState(member?.username ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [color, setColor] = useState(member?.color ?? '#0078d4');
  const [active, setActive] = useState(member?.active ?? true);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const input = { name: name.trim(), username: username.trim(), email: email.trim(), active, ...(member || color !== '#0078d4' ? { color } : {}) };
    if (member) await api.updateMember(member.id, input);
    else await api.createMember(input);
    onClose();
  };
  return (
    <Modal title={member ? `Edit ${member.name}` : 'Add team member'} onClose={onClose} width={420}>
      <form className="form" onSubmit={submit}>
        <label>
          Display name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={128} />
        </label>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={64}
            pattern="[A-Za-z0-9._\-]*"
            title="Letters, numbers, dots, dashes and underscores"
            placeholder="e.g. jnunner"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="muted small field-hint">Used to sign in when sign-in is turned on.</span>
        </label>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={256} />
        </label>
        <div className="form-row">
          <label>
            Avatar color
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
          </label>
        </div>
        <div className="modal-footer inline">
          <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
            Save
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SprintSettings() {
  const sprints = useSortedSprints();
  const items = useStore((s) => s.workItems);
  const workingDays = useStore((s) => s.settings.workingDays);
  const today = useToday();
  const [editing, setEditing] = useState<Sprint | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Sprint | null>(null);
  return (
    <div className="settings-card">
      <div className="row between">
        <h2>Sprints</h2>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          <Icon name="add" size={12} /> New sprint
        </button>
      </div>
      <p className="muted small">Sprints (iterations) the team plans work into. Dates drive capacity, burndown and the "current sprint".</p>
      {sprints.length === 0 ? (
        <EmptyState icon="sprint" title="No sprints yet" />
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Start</th>
              <th>End</th>
              <th>Working days</th>
              <th>Items</th>
              <th>Status</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {sprints.map((s) => {
              const tf = sprintTimeframe(s, today);
              return (
                <tr key={s.id} className="grid-row">
                  <td>
                    <Link to={`/sprints/${s.id}/taskboard`}>{s.name}</Link>
                    {s.goal && <div className="muted small ellipsis">{s.goal}</div>}
                  </td>
                  <td>{formatShortDate(s.startDate)}</td>
                  <td>{formatShortDate(s.finishDate)}</td>
                  <td className="num">{s.startDate && s.finishDate ? workingDaysBetween(s.startDate, s.finishDate, workingDays).length : ''}</td>
                  <td className="num">{items.filter((w) => w.iterationId === s.id).length}</td>
                  <td>{tf === 'current' ? <span className="badge badge-current">Current</span> : <span className="muted">{tf === 'past' ? 'Past' : tf === 'future' ? 'Future' : 'No dates'}</span>}</td>
                  <td className="col-actions">
                    <button className="icon-btn" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s)}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button className="icon-btn" aria-label={`Delete ${s.name}`} onClick={() => setDeleting(s)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editing && <SprintDialog sprint={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {deleting && <DeleteSprintDialog sprint={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function DeleteSprintDialog({ sprint, onClose }: { sprint: Sprint; onClose: () => void }) {
  const sprints = useSortedSprints();
  const count = useStore((s) => s.workItems.filter((w) => w.iterationId === sprint.id).length);
  const [moveTo, setMoveTo] = useState('');
  return (
    <Modal
      title={`Delete ${sprint.name}?`}
      onClose={onClose}
      width={440}
      footer={
        <>
          <button
            className="btn btn-danger"
            onClick={async () => {
              await api.deleteSprint(sprint.id, moveTo || null);
              toast(`${sprint.name} deleted`);
              onClose();
            }}
          >
            Delete sprint
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <div className="form">
        <p>{count ? `${count} work item${count === 1 ? '' : 's'} in this sprint will be moved to:` : 'This sprint has no work items.'}</p>
        {count > 0 && (
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move work to">
            <option value="">Backlog (unscheduled)</option>
            {sprints
              .filter((s) => s.id !== sprint.id)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        )}
      </div>
    </Modal>
  );
}

const KIND_LABEL: Record<SnapshotMeta['kind'], string> = {
  manual: 'Manual',
  auto: 'Automatic',
  'pre-restore': 'Before restore',
  'pre-import': 'Before import',
  'pre-reset': 'Before reset',
};

function BackupSettings() {
  const settings = useStore((s) => s.settings);
  const itemCount = useStore((s) => s.workItems.length);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[] | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<SnapshotMeta | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [auto, setAuto] = useState(settings.backup);
  const autoDirty = JSON.stringify(auto) !== JSON.stringify(settings.backup);

  const refresh = useCallback(() => {
    api
      .listSnapshots()
      .then(setSnapshots)
      .catch((e) => toast(e.message, 'error'));
  }, []);
  useEffect(refresh, [refresh]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Operation failed', 'error');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const s = await api.createSnapshot(name.trim(), description.trim());
      setName('');
      setDescription('');
      toast(`Snapshot "${s.name}" created`, 'success');
    });
  };

  const restore = async (s: SnapshotMeta) => {
    const ok = await confirmDialog({
      title: `Restore "${s.name}"?`,
      message: (
        <>
          <p>
            All work items, sprints, capacity and team settings will be replaced with the snapshot taken {formatDateTime(s.createdAt)} ({s.stats.workItems} work items).
          </p>
          <p className="muted">A safety snapshot of the current data is taken first, so you can undo this.</p>
        </>
      ),
      confirmLabel: 'Restore',
      danger: true,
    });
    if (!ok) return;
    void run(async () => {
      await api.restoreSnapshot(s.id);
      toast(`Restored "${s.name}"`, 'success');
    });
  };

  const onImport = async (file: File) => {
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast('That file is not valid JSON', 'error');
      return;
    }
    const ok = await confirmDialog({
      title: `Import ${file.name}?`,
      message: 'The current data will be replaced by the backup. A safety snapshot is taken first.',
      confirmLabel: 'Import',
      danger: true,
    });
    if (!ok) return;
    void run(async () => {
      await api.importBackup(data);
      toast('Backup imported', 'success');
    });
  };

  const reset = async (mode: 'empty' | 'demo') => {
    const ok = await confirmDialog({
      title: mode === 'empty' ? 'Start with an empty project?' : 'Load demo data?',
      message: `All ${itemCount} work items, sprints and team members will be replaced${mode === 'empty' ? ' with an empty project (settings are kept)' : ' with the demo project'}. A safety snapshot is taken first.`,
      confirmLabel: mode === 'empty' ? 'Clear data' : 'Load demo',
      danger: true,
    });
    if (!ok) return;
    void run(async () => {
      await api.resetData(mode);
      toast(mode === 'empty' ? 'Project cleared' : 'Demo data loaded', 'success');
    });
  };

  return (
    <div className="settings-stack">
      <div className="settings-card">
        <h2>Take a snapshot</h2>
        <p className="muted small">A snapshot is a point-in-time copy of everything: work items (with history and comments), links, sprints, capacity, team and settings. Restore it at any time.</p>
        <form className="form-row snapshot-form" onSubmit={create}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Before sprint 4 planning)" maxLength={200} aria-label="Snapshot name" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" maxLength={2000} aria-label="Snapshot description" />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            <Icon name="backup" size={14} /> Take snapshot
          </button>
        </form>
      </div>

      <div className="settings-card">
        <div className="row between">
          <h2>Snapshots</h2>
          <button className="icon-btn" onClick={refresh} title="Refresh">
            <Icon name="restore" size={14} />
          </button>
        </div>
        {snapshots === null ? (
          <div className="muted">Loading…</div>
        ) : snapshots.length === 0 ? (
          <EmptyState icon="backup" title="No snapshots yet" />
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Created</th>
                <th>Contents</th>
                <th>Size</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id} className="grid-row">
                  <td>
                    <strong>{s.name}</strong>
                    {s.description && <div className="muted small">{s.description}</div>}
                  </td>
                  <td>
                    <span className={`badge kind-${s.kind}`}>{KIND_LABEL[s.kind]}</span>
                  </td>
                  <td title={formatDateTime(s.createdAt)}>
                    {timeAgo(s.createdAt)}
                    <div className="muted small">by {s.createdBy}</div>
                  </td>
                  <td className="small">
                    {s.stats.workItems} items · {s.stats.sprints} sprints · {s.stats.members} members
                  </td>
                  <td className="small muted">{formatBytes(s.sizeBytes)}</td>
                  <td className="col-actions nowrap">
                    <button className="btn btn-small" disabled={busy} onClick={() => restore(s)}>
                      <Icon name="restore" size={12} /> Restore
                    </button>
                    <a className="icon-btn" href={`/api/snapshots/${s.id}/download`} title="Download" aria-label="Download snapshot">
                      <Icon name="download" size={14} />
                    </a>
                    <button className="icon-btn" title="Rename" aria-label="Rename snapshot" onClick={() => setEditing(s)}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Delete"
                      aria-label="Delete snapshot"
                      onClick={async () => {
                        if (await confirmDialog({ title: `Delete snapshot "${s.name}"?`, message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) {
                          void run(() => api.deleteSnapshot(s.id));
                        }
                      }}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="settings-card">
        <h2>Backup files</h2>
        <p className="muted small">Download a full backup as a JSON file to keep off-server, or import a backup (or a downloaded snapshot) to replace the current data.</p>
        <div className="row gap wrap">
          <a className="btn btn-primary" href="/api/backup/export" download>
            <Icon name="download" size={14} /> Export backup
          </a>
          <button className="btn" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={14} /> Import backup…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onImport(f);
            }}
          />
        </div>
      </div>

      <div className="settings-card">
        <h2>Automatic backups</h2>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            await api.updateSettings({ backup: auto });
            toast('Automatic backup settings saved', 'success');
          }}
        >
          <label className="check-row">
            <input type="checkbox" checked={auto.autoEnabled} onChange={(e) => setAuto({ ...auto, autoEnabled: e.target.checked })} /> Take automatic snapshots
          </label>
          <div className="form-row">
            <label>
              Every (hours)
              <input type="number" min={1} max={720} value={auto.intervalHours} disabled={!auto.autoEnabled} onChange={(e) => setAuto({ ...auto, intervalHours: Math.max(1, Number(e.target.value) || 1) })} />
            </label>
            <label>
              Keep the latest
              <input type="number" min={1} max={365} value={auto.retain} disabled={!auto.autoEnabled} onChange={(e) => setAuto({ ...auto, retain: Math.max(1, Math.round(Number(e.target.value)) || 1) })} />
            </label>
          </div>
          <div className="muted small">Manual and safety snapshots are never deleted automatically.</div>
          <div>
            <button className="btn btn-primary" type="submit" disabled={!autoDirty}>
              Save
            </button>
          </div>
        </form>
      </div>

      <div className="settings-card danger-zone">
        <h2>Reset</h2>
        <p className="muted small">Replace all project data. A safety snapshot is taken first so you can restore it.</p>
        <div className="row gap wrap">
          <button className="btn btn-danger" disabled={busy} onClick={() => reset('empty')}>
            Start with an empty project
          </button>
          <button className="btn" disabled={busy} onClick={() => reset('demo')}>
            Load demo data
          </button>
        </div>
      </div>

      {editing && <RenameSnapshot snapshot={editing} onClose={() => setEditing(null)} onSaved={refresh} />}
    </div>
  );
}

function RenameSnapshot({ snapshot, onClose, onSaved }: { snapshot: SnapshotMeta; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(snapshot.name);
  const [description, setDescription] = useState(snapshot.description);
  return (
    <Modal title="Edit snapshot" onClose={onClose} width={440}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api.updateSnapshot(snapshot.id, { name: name.trim(), description });
            onSaved();
            onClose();
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Failed', 'error');
          }
        }}
      >
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          Description
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
        </label>
        <div className="modal-footer inline">
          <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
            Save
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RecycleBin() {
  const bin = useStore((s) => s.recycleBin);
  return (
    <div className="settings-card">
      <h2>Recycle bin</h2>
      <p className="muted small">Deleted work items are kept here until permanently deleted. Restoring brings back the item with its history, comments and links.</p>
      {bin.length === 0 ? (
        <EmptyState icon="trash" title="The recycle bin is empty" />
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>State</th>
              <th>Deleted</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {bin.map((r) => (
              <tr key={r.item.id} className="grid-row">
                <td className="muted">{r.item.id}</td>
                <td>
                  <span className="row gap-s">
                    <TypeIcon type={r.item.type} /> {r.item.title}
                  </span>
                </td>
                <td>
                  <StateBadge type={r.item.type} state={r.item.state} />
                </td>
                <td>
                  {timeAgo(r.deletedAt)} <span className="muted small">by {r.deletedBy}</span>
                </td>
                <td className="col-actions nowrap">
                  <button
                    className="btn btn-small"
                    onClick={async () => {
                      await api.restoreDeleted(r.item.id);
                      toast(`Restored #${r.item.id}`, 'success');
                    }}
                  >
                    <Icon name="restore" size={12} /> Restore
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="Delete permanently"
                    title="Delete permanently"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Permanently delete #${r.item.id}?`, message: 'This cannot be undone (except by restoring a snapshot).', confirmLabel: 'Delete permanently', danger: true })) {
                        await api.purgeDeleted(r.item.id);
                      }
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
