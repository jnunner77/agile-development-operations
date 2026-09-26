import { useEffect, useMemo, useState } from 'react';
import { countDaysOff, formatRange } from '../../../../shared/dates';
import { ACTIVITIES } from '../../../../shared/process';
import { computeCapacity, sprintTimeframe } from '../../../../shared/sprints';
import type { DateRange, MemberCapacity, Sprint, SprintCapacity } from '../../../../shared/types';
import { api } from '../../api';
import { Avatar, EmptyState, Modal, useMenu } from '../../components/common';
import { Icon } from '../../components/Icon';
import { DateRangesEditor } from '../../components/inputs';
import { formatHours } from '../../lib/format';
import { useMembersById, useSortedSprints, useToday } from '../../lib/hooks';
import { toast, useStore } from '../../store';

export function CapacityView({ sprint, onPreview }: { sprint: Sprint; onPreview: (c: SprintCapacity | null) => void }) {
  const saved = useStore((s) => s.capacities.find((c) => c.sprintId === sprint.id));
  const members = useStore((s) => s.members);
  const workingDays = useStore((s) => s.settings.workingDays);
  const membersById = useMembersById();
  const sprints = useSortedSprints();
  const today = useToday();
  const menu = useMenu();
  const base = useMemo<SprintCapacity>(() => saved ?? { sprintId: sprint.id, teamDaysOff: [], members: [] }, [saved, sprint.id]);
  const [draft, setDraft] = useState<SprintCapacity>(base);
  const [daysOffFor, setDaysOffFor] = useState<string | 'team' | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(base);

  // Pick up changes made elsewhere while there are no local edits.
  useEffect(() => {
    if (!dirty) setDraft(base);
  }, [base]);
  useEffect(() => {
    onPreview(dirty ? draft : null);
    return () => onPreview(null);
  }, [draft, dirty, onPreview]);

  const summary = computeCapacity(sprint, draft, workingDays, today);
  const updateMember = (memberId: string, fn: (m: MemberCapacity) => MemberCapacity) =>
    setDraft((d) => ({ ...d, members: d.members.map((m) => (m.memberId === memberId ? fn(m) : m)) }));

  const missing = members.filter((m) => m.active && !draft.members.some((x) => x.memberId === m.id));
  const addMember = (memberId: string) =>
    setDraft((d) => ({ ...d, members: [...d.members, { memberId, activities: [{ activity: '', capacityPerDay: 0 }], daysOff: [] }] }));

  const save = async () => {
    setSaving(true);
    try {
      await api.setCapacity(sprint.id, { teamDaysOff: draft.teamDaysOff, members: draft.members });
      toast('Capacity saved', 'success');
    } finally {
      setSaving(false);
    }
  };

  const previous = sprints.filter((s) => s.id !== sprint.id && (!sprint.startDate || !s.startDate || s.startDate < sprint.startDate)).reverse();

  if (!sprint.startDate || !sprint.finishDate) {
    return (
      <EmptyState icon="calendar" title="Set sprint dates to plan capacity">
        Capacity is calculated from the working days between the sprint's start and end dates.
      </EmptyState>
    );
  }

  const rangeFor = daysOffFor === 'team' ? draft.teamDaysOff : draft.members.find((m) => m.memberId === daysOffFor)?.daysOff;

  return (
    <div className="sprint-view capacity">
      <div className="view-toolbar">
        <button
          className="btn btn-primary-ghost"
          disabled={!missing.length}
          onClick={(e) => menu.openAt(e, [...missing.map((m) => ({ label: m.name, onClick: () => addMember(m.id) })), { divider: true }, { label: 'Add all team members', onClick: () => missing.forEach((m) => addMember(m.id)) }])}
        >
          <Icon name="add" size={14} /> Add user
        </button>
        <button className="btn btn-ghost" onClick={() => setDaysOffFor('team')}>
          <Icon name="calendar" size={14} /> Team days off {draft.teamDaysOff.length > 0 && <span className="count-pill">{summary.teamDaysOff}</span>}
        </button>
        <button
          className="btn btn-ghost"
          disabled={!previous.length}
          onClick={(e) =>
            menu.openAt(
              e,
              previous.map((s) => ({
                label: `Copy from ${s.name}`,
                onClick: async () => {
                  if (dirty) setDraft(base);
                  await api.copyCapacity(sprint.id, s.id);
                  toast(`Copied capacity from ${s.name}`, 'success');
                },
              })),
            )
          }
        >
          <Icon name="copy" size={14} /> Copy from sprint
        </button>
        <div className="spacer" />
        {dirty && <span className="muted small">Unsaved changes</span>}
        <button className="btn" disabled={!dirty || saving} onClick={() => setDraft(base)}>
          <Icon name="undo" size={14} /> Undo
        </button>
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
          <Icon name="save" size={14} /> Save
        </button>
      </div>
      <div className="capacity-summary">
        <div className="stat">
          <span className="stat-label">Working days</span>
          <span className="stat-value">{summary.workingDays}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Days remaining</span>
          <span className="stat-value">{summary.remainingWorkingDays}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Team days off</span>
          <span className="stat-value">{summary.teamDaysOff}</span>
        </div>
        <div className="stat">
          <span className="stat-label">{sprintTimeframe(sprint, today) === 'current' ? 'Remaining capacity' : 'Total capacity'}</span>
          <span className="stat-value">{formatHours(sprintTimeframe(sprint, today) === 'current' ? summary.remainingCapacity : summary.totalCapacity) || '0 h'}</span>
        </div>
      </div>
      {draft.members.length === 0 ? (
        <EmptyState icon="people" title="No one is set up for this sprint">
          Add team members and how many hours a day each can work on the sprint.
        </EmptyState>
      ) : (
        <div className="grid-wrap">
          <table className="grid capacity-grid">
            <thead>
              <tr>
                <th>User</th>
                <th>Days off</th>
                <th>Activity</th>
                <th>Capacity per day</th>
                <th>Sprint capacity</th>
                <th className="col-actions" />
              </tr>
            </thead>
            <tbody>
              {draft.members.map((mc) => {
                const m = membersById.get(mc.memberId);
                const s = summary.members.find((x) => x.memberId === mc.memberId);
                const personal = countDaysOff(mc.daysOff, sprint.startDate!, sprint.finishDate!, workingDays);
                return mc.activities.map((a, idx) => (
                  <tr key={`${mc.memberId}-${idx}`} className={idx > 0 ? 'row-sub' : ''}>
                    <td>
                      {idx === 0 && (
                        <span className="person">
                          <Avatar member={m} size={24} />
                          <span>{m?.name ?? 'Former member'}</span>
                        </span>
                      )}
                    </td>
                    <td>
                      {idx === 0 && (
                        <button className="link-btn" onClick={() => setDaysOffFor(mc.memberId)} title={mc.daysOff.map(formatRange).join(', ')}>
                          {personal} day{personal === 1 ? '' : 's'}
                          {summary.teamDaysOff > 0 && <span className="muted"> + {summary.teamDaysOff} team</span>}
                        </button>
                      )}
                    </td>
                    <td>
                      <select
                        value={a.activity}
                        aria-label="Activity"
                        onChange={(e) =>
                          updateMember(mc.memberId, (x) => ({ ...x, activities: x.activities.map((y, i) => (i === idx ? { ...y, activity: e.target.value } : y)) }))
                        }
                      >
                        <option value="">Unassigned</option>
                        {ACTIVITIES.map((act) => (
                          <option key={act}>{act}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number"
                        className="capacity-input"
                        min={0}
                        max={24}
                        step={0.5}
                        aria-label="Capacity per day"
                        value={a.capacityPerDay}
                        onChange={(e) => {
                          const v = Math.max(0, Math.min(24, Number(e.target.value) || 0));
                          updateMember(mc.memberId, (x) => ({ ...x, activities: x.activities.map((y, i) => (i === idx ? { ...y, capacityPerDay: v } : y)) }));
                        }}
                      />
                      {idx === mc.activities.length - 1 && mc.activities.length < 6 && (
                        <button
                          className="icon-btn"
                          title="Add another activity"
                          onClick={() => updateMember(mc.memberId, (x) => ({ ...x, activities: [...x.activities, { activity: '', capacityPerDay: 0 }] }))}
                        >
                          <Icon name="add" size={12} />
                        </button>
                      )}
                    </td>
                    <td className="num muted">{idx === 0 && s ? formatHours(s.totalCapacity) : ''}</td>
                    <td className="col-actions">
                      <button
                        className="icon-btn"
                        aria-label={idx === 0 && mc.activities.length === 1 ? 'Remove user' : 'Remove activity'}
                        title={mc.activities.length === 1 ? 'Remove user from sprint capacity' : 'Remove activity'}
                        onClick={() =>
                          mc.activities.length === 1
                            ? setDraft((d) => ({ ...d, members: d.members.filter((x) => x.memberId !== mc.memberId) }))
                            : updateMember(mc.memberId, (x) => ({ ...x, activities: x.activities.filter((_, i) => i !== idx) }))
                        }
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      )}
      {daysOffFor && rangeFor && (
        <Modal
          title={daysOffFor === 'team' ? 'Team days off' : `Days off for ${membersById.get(daysOffFor)?.name ?? ''}`}
          onClose={() => setDaysOffFor(null)}
          width={480}
          footer={
            <button className="btn btn-primary" onClick={() => setDaysOffFor(null)}>
              Done
            </button>
          }
        >
          <p className="muted small">
            {sprint.name} runs {formatRange({ start: sprint.startDate, end: sprint.finishDate })}. Only working days inside the sprint reduce capacity. Remember to save the capacity page after editing.
          </p>
          <DateRangesEditor
            value={rangeFor}
            min={sprint.startDate}
            max={sprint.finishDate}
            onChange={(ranges: DateRange[]) =>
              daysOffFor === 'team' ? setDraft((d) => ({ ...d, teamDaysOff: ranges })) : updateMember(daysOffFor, (x) => ({ ...x, daysOff: ranges }))
            }
          />
        </Modal>
      )}
      {menu.element}
    </div>
  );
}
