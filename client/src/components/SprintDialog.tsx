import { useState } from 'react';
import { workingDaysBetween } from '../../../shared/dates';
import { suggestNextSprint } from '../../../shared/sprints';
import type { Sprint } from '../../../shared/types';
import { api } from '../api';
import { useToday } from '../lib/hooks';
import { toast, useStore } from '../store';
import { Modal } from './common';

/** Create or edit a sprint. */
export function SprintDialog({ sprint, onClose, onSaved }: { sprint?: Sprint; onClose: () => void; onSaved?: (s: Sprint) => void }) {
  const sprints = useStore((s) => s.sprints);
  const workingDays = useStore((s) => s.settings.workingDays);
  const today = useToday();
  const [suggested] = useState(() => suggestNextSprint(sprints, today));
  const [name, setName] = useState(sprint?.name ?? suggested.name);
  const [startDate, setStart] = useState(sprint ? (sprint.startDate ?? '') : (suggested.startDate ?? ''));
  const [finishDate, setFinish] = useState(sprint ? (sprint.finishDate ?? '') : (suggested.finishDate ?? ''));
  const [goal, setGoal] = useState(sprint?.goal ?? '');
  const [saving, setSaving] = useState(false);
  const days = startDate && finishDate && finishDate >= startDate ? workingDaysBetween(startDate, finishDate, workingDays).length : 0;
  const overlaps = sprints.filter((s) => s.id !== sprint?.id && s.startDate && s.finishDate && startDate && finishDate && s.startDate <= finishDate && s.finishDate >= startDate);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const input = { name: name.trim(), startDate: startDate || null, finishDate: finishDate || null, goal };
      const saved = sprint ? await api.updateSprint(sprint.id, input) : await api.createSprint(input);
      toast(sprint ? 'Sprint updated' : `${saved.name} created`, 'success');
      onSaved?.(saved);
      onClose();
    } catch {
      setSaving(false);
    }
  };

  return (
    <Modal title={sprint ? `Edit ${sprint.name}` : 'Create a new sprint'} onClose={onClose} width={460}>
      <form className="form" onSubmit={submit}>
        <label>
          Sprint name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={128} />
        </label>
        <div className="form-row">
          <label>
            Start
            <input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            End
            <input type="date" value={finishDate} min={startDate} onChange={(e) => setFinish(e.target.value)} />
          </label>
        </div>
        <div className="muted small">
          {days > 0 ? `${days} working days` : 'Sprints without dates are allowed but won\'t show capacity or burndown.'}
          {overlaps.length > 0 && <div className="warn">Overlaps with {overlaps.map((s) => s.name).join(', ')}</div>}
        </div>
        <label>
          Sprint goal
          <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} placeholder="What does the team want to achieve this sprint?" />
        </label>
        <div className="modal-footer inline">
          <button className="btn btn-primary" type="submit" disabled={saving || !name.trim() || (!!startDate !== !!finishDate)}>
            {sprint ? 'Save' : 'Create'}
          </button>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
