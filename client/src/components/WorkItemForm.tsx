import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  ACTIVITIES,
  LINK_REVERSE,
  LINK_TYPES,
  RISKS,
  SEVERITIES,
  TYPE_DEFS,
  TYPE_FIELDS,
  VALUE_AREAS,
  WORK_ITEM_TYPES,
  defaultState,
  type LinkType,
  type WorkItemType,
} from '../../../shared/process';
import { sprintTimeframe } from '../../../shared/sprints';
import type { WorkItem } from '../../../shared/types';
import { api, type WorkItemFields } from '../api';
import { FIELD_LABELS, HTML_FIELDS, formatDateTime, formatFieldValue, formatHours, timeAgo } from '../lib/format';
import { rollup, useChildrenMap, useItemsById, useSortedSprints, useToday } from '../lib/hooks';
import { toast, useStore } from '../store';
import { Avatar, StateBadge, confirmDialog, useMenu } from './common';
import { Icon, TypeIcon } from './Icon';
import { MemberSelect, NumberInput, TagsInput, WorkItemPicker } from './inputs';
import { RichTextEditor, RichView } from './RichText';
import { DevelopmentSection } from './Development';

type Draft = WorkItemFields;

/** Opens work items in the dialog via the `wi` query parameter so the URL is shareable. */
export function useWorkItemDialog() {
  const [params, setParams] = useSearchParams();
  const open = useCallback(
    (id: number) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set('wi', String(id));
        for (const k of ['type', 'parent', 'iteration']) next.delete(k);
        return next;
      }),
    [setParams],
  );
  const openNew = useCallback(
    (type: WorkItemType, opts: { parentId?: number | null; iterationId?: string | null } = {}) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set('wi', 'new');
        next.set('type', type);
        if (opts.parentId) next.set('parent', String(opts.parentId));
        else next.delete('parent');
        if (opts.iterationId) next.set('iteration', opts.iterationId);
        else next.delete('iteration');
        return next;
      }),
    [setParams],
  );
  const close = useCallback(
    () =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        for (const k of ['wi', 'type', 'parent', 'iteration']) next.delete(k);
        return next;
      }),
    [setParams],
  );
  return { params, open, openNew, close };
}

export function WorkItemDialogHost() {
  const { params, open, close } = useWorkItemDialog();
  const wi = params.get('wi');
  const itemsById = useItemsById();
  const loaded = useStore((s) => s.loaded);
  if (!wi || !loaded) return null;
  if (wi === 'new') {
    const type = params.get('type') as WorkItemType;
    if (!WORK_ITEM_TYPES.includes(type)) return null;
    const parent = Number(params.get('parent')) || null;
    return <WorkItemForm key={`new-${type}-${parent}`} newType={type} newParentId={parent} newIterationId={params.get('iteration')} onClose={close} onCreated={open} />;
  }
  const item = itemsById.get(Number(wi));
  if (!item) {
    return (
      <div className="modal-backdrop" onMouseDown={close}>
        <div className="modal" style={{ width: 420 }}>
          <div className="modal-header">
            <h2>Work item {wi} not found</h2>
          </div>
          <div className="modal-body">It may have been deleted. Check the recycle bin in Settings.</div>
          <div className="modal-footer">
            <button className="btn" onClick={close}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }
  return <WorkItemForm key={item.id} item={item} onClose={close} onCreated={open} />;
}

interface FormProps {
  item?: WorkItem;
  newType?: WorkItemType;
  newParentId?: number | null;
  newIterationId?: string | null;
  onClose: () => void;
  onCreated: (id: number) => void;
}

function WorkItemForm({ item, newType, newParentId, newIterationId, onClose, onCreated }: FormProps) {
  const isNew = !item;
  const type = (item?.type ?? newType)!;
  const def = TYPE_DEFS[type];
  const itemsById = useItemsById();
  const settings = useStore((s) => s.settings);
  const [tab, setTab] = useState<'details' | 'history' | 'links'>('details');
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => {
    if (item) return {};
    const parent = newParentId ? itemsById.get(newParentId) : undefined;
    return {
      title: '',
      state: defaultState(type),
      parentId: newParentId ?? null,
      iterationId: newIterationId ?? (type === 'Task' ? (parent?.iterationId ?? null) : null),
      areaPath: parent?.areaPath || settings.areaPaths[0] || settings.projectName,
      priority: 2,
      valueArea: type === 'Task' ? null : 'Business',
      severity: type === 'Bug' ? '3 - Medium' : null,
      assignedTo: null,
      tags: [],
    };
  });
  const dirty = Object.keys(draft).length > 0 && (isNew ? true : Object.keys(draft).some((k) => JSON.stringify(draft[k as keyof Draft]) !== JSON.stringify(item![k as keyof WorkItem])));

  const get = <K extends keyof Draft>(field: K): Draft[K] => (field in draft ? draft[field] : (item?.[field as keyof WorkItem] as Draft[K]));
  const set = <K extends keyof Draft>(field: K, value: Draft[K]) => setDraft((d) => ({ ...d, [field]: value }));

  const save = async (andClose: boolean) => {
    const title = String(get('title') ?? '').trim();
    if (!title) {
      toast('Title is required', 'error');
      return;
    }
    setSaving(true);
    try {
      if (isNew) {
        const created = await api.createWorkItem(type, { ...draft, title } as Draft & { title: string });
        toast(`${def.name} ${created.id} created`, 'success');
        if (andClose) onClose();
        else onCreated(created.id);
      } else {
        const changes: Draft = {};
        for (const [k, v] of Object.entries(draft)) {
          if (JSON.stringify(v) !== JSON.stringify(item![k as keyof WorkItem])) (changes as Record<string, unknown>)[k] = v;
        }
        if (Object.keys(changes).length) await api.updateWorkItem(item!.id, changes);
        setDraft({});
        if (andClose) onClose();
      }
    } catch {
      // toast already shown
    } finally {
      setSaving(false);
    }
  };

  const tryClose = useCallback(async () => {
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', message: 'You have unsaved changes to this work item.', confirmLabel: 'Discard', danger: true }))) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void save(false);
      } else if (e.key === 'Escape' && !document.querySelector('.modal, .menu')) {
        void tryClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const menu = useMenu();
  const moreItems = item
    ? [
        {
          label: 'Copy link',
          icon: 'link',
          onClick: () => {
            const url = new URL(window.location.href);
            url.search = `?wi=${item.id}`;
            void navigator.clipboard?.writeText(url.toString());
            toast('Link copied to clipboard');
          },
        },
        {
          label: 'Create copy of work item',
          icon: 'copy',
          onClick: async () => {
            const copy = await api.copyWorkItem(item.id, false);
            onCreated(copy.id);
          },
        },
        ...(def.childTypes.length
          ? [
              {
                label: 'Create copy with children',
                icon: 'copy',
                onClick: async () => {
                  const copy = await api.copyWorkItem(item.id, true);
                  onCreated(copy.id);
                },
              },
            ]
          : []),
        { divider: true },
        {
          label: 'Delete',
          icon: 'trash',
          danger: true,
          onClick: async () => {
            const ok = await confirmDialog({
              title: `Delete ${def.name} ${item.id}?`,
              message: 'The work item will be moved to the recycle bin. Child items will be kept but unparented.',
              confirmLabel: 'Delete',
              danger: true,
            });
            if (!ok) return;
            await api.deleteWorkItem(item.id);
            toast(`${def.name} ${item.id} deleted`);
            onClose();
          },
        },
      ]
    : [];

  const commentsCount = item?.comments.length ?? 0;
  const storeLinks = useStoreLinksCount(item?.id ?? -1);
  const linksCount = item ? storeLinks + item.hyperlinks.length : 0;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && void tryClose()}>
      <div className="wi-form" role="dialog" aria-modal="true" aria-label={`${def.name} ${item?.id ?? '(new)'}`} style={{ borderTopColor: def.color }}>
        <div className="wi-header">
          <div className="wi-header-top">
            <span className="wi-type-label">
              <TypeIcon type={type} />
              {def.name.toUpperCase()} {item ? item.id : '*'}
            </span>
            <div className="wi-header-actions">
              {dirty && <span className="dirty-dot" title="Unsaved changes" />}
              <button className="btn btn-primary" disabled={saving || (!dirty && !isNew)} onClick={() => save(true)}>
                <Icon name="save" size={14} /> Save &amp; Close
              </button>
              <button className="btn" disabled={saving || (!dirty && !isNew)} onClick={() => save(false)} title="Save (Ctrl+S)">
                Save
              </button>
              {item && (
                <button className="icon-btn" aria-label="More actions" onClick={(e) => menu.openAt(e, moreItems)}>
                  <Icon name="more" />
                </button>
              )}
              <button className="icon-btn" aria-label="Close" onClick={() => void tryClose()}>
                <Icon name="close" />
              </button>
            </div>
          </div>
          <input
            className="wi-title"
            value={String(get('title') ?? '')}
            placeholder="Enter title"
            autoFocus={isNew}
            onChange={(e) => set('title', e.target.value)}
            aria-label="Title"
            maxLength={255}
          />
          <div className="wi-header-row">
            <MemberSelect value={(get('assignedTo') as string | null) ?? null} onChange={(v) => set('assignedTo', v)} />
            {item && (
              <button className="link-btn" onClick={() => document.getElementById('wi-discussion')?.scrollIntoView({ behavior: 'smooth' })}>
                <Icon name="comment" size={14} /> {commentsCount} comment{commentsCount === 1 ? '' : 's'}
              </button>
            )}
            <TagsInput value={(get('tags') as string[]) ?? []} onChange={(t) => set('tags', t)} />
          </div>
          <div className="wi-header-fields">
            <label>
              <span>State</span>
              <select value={String(get('state'))} onChange={(e) => set('state', e.target.value)}>
                {def.states.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Reason</span>
              <input value={item && !('state' in draft) ? item.reason : (def.states.find((s) => s.name === get('state'))?.reason ?? '')} readOnly tabIndex={-1} />
            </label>
            <label>
              <span>Area</span>
              <select value={String(get('areaPath') ?? '')} onChange={(e) => set('areaPath', e.target.value)}>
                {[...new Set([...settings.areaPaths, String(get('areaPath') ?? '')])].filter(Boolean).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Iteration</span>
              <IterationSelect value={(get('iterationId') as string | null) ?? null} onChange={(v) => set('iterationId', v)} />
            </label>
          </div>
          <div className="tabs wi-tabs">
            <button className={tab === 'details' ? 'active' : ''} onClick={() => setTab('details')}>
              Details
            </button>
            <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')} disabled={isNew}>
              <Icon name="history" size={14} /> History
            </button>
            <button className={tab === 'links' ? 'active' : ''} onClick={() => setTab('links')} disabled={isNew}>
              <Icon name="link" size={14} /> Links {linksCount > 0 && <span className="count-pill">{linksCount}</span>}
            </button>
          </div>
        </div>
        <div className="wi-body">
          {tab === 'details' && <DetailsTab type={type} item={item} get={get} set={set} />}
          {tab === 'history' && item && <HistoryTab item={item} />}
          {tab === 'links' && item && <LinksTab item={item} />}
        </div>
        {menu.element}
      </div>
    </div>
  );
}

function useStoreLinksCount(id: number) {
  return useStore((s) => s.links.filter((l) => l.sourceId === id || l.targetId === id).length);
}

export function IterationSelect({ value, onChange, className }: { value: string | null; onChange: (v: string | null) => void; className?: string }) {
  const sprints = useSortedSprints();
  const today = useToday();
  const projectName = useStore((s) => s.settings.projectName);
  return (
    <select className={className} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} aria-label="Iteration">
      <option value="">{projectName} (Backlog)</option>
      {sprints.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
          {sprintTimeframe(s, today) === 'current' ? ' (Current)' : ''}
        </option>
      ))}
    </select>
  );
}

type Getter = <K extends keyof Draft>(field: K) => Draft[K];
type Setter = <K extends keyof Draft>(field: K, value: Draft[K]) => void;

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="wi-section">
      <div className="wi-section-header">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="wi-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function DetailsTab({ type, item, get, set }: { type: WorkItemType; item?: WorkItem; get: Getter; set: Setter }) {
  const fields = TYPE_FIELDS[type];
  const has = (f: string) => fields.includes(f);
  const children = useChildrenMap();
  const roll = item ? rollup(item, children) : null;
  const num = (f: keyof Draft, label: string, step = 1) =>
    has(f) && (
      <Field label={label}>
        <NumberInput value={(get(f) as number | null) ?? null} onChange={(v) => set(f, v as never)} step={step} ariaLabel={label} />
      </Field>
    );
  const select = (f: keyof Draft, label: string, options: readonly (string | number)[]) =>
    has(f) && (
      <Field label={label}>
        <select value={String(get(f) ?? '')} onChange={(e) => set(f, (e.target.value === '' ? null : f === 'priority' ? Number(e.target.value) : e.target.value) as never)}>
          <option value="" />
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </Field>
    );
  const date = (f: keyof Draft, label: string) =>
    has(f) && (
      <Field label={label}>
        <input type="date" value={String(get(f) ?? '')} onChange={(e) => set(f, (e.target.value || null) as never)} />
      </Field>
    );
  const rich = (f: 'description' | 'acceptanceCriteria' | 'reproSteps' | 'systemInfo', title: string, placeholder: string) =>
    has(f) && (
      <Section title={title}>
        <RichTextEditor value={String(get(f) ?? '')} onChange={(v) => set(f, v)} placeholder={placeholder} />
      </Section>
    );
  const due = get('dueDate') as string | null;
  const today = useToday();

  return (
    <div className="wi-details">
      <div className="wi-main">
        {rich('reproSteps', 'Repro Steps', 'Steps to reproduce, expected and actual results')}
        {rich('systemInfo', 'System Info', 'Browser, OS, environment, build')}
        {rich('description', 'Description', 'Click to add a description')}
        {rich('acceptanceCriteria', 'Acceptance Criteria', 'Define what "done" looks like')}
        {item ? <Discussion item={item} /> : <div className="muted small">Save the work item to start a discussion.</div>}
      </div>
      <div className="wi-side">
        <Section title="Planning">
          {select('priority', 'Priority', [1, 2, 3, 4])}
          {select('severity', 'Severity', SEVERITIES)}
          {num('effort', type === 'Epic' || type === 'Feature' ? 'Effort' : 'Effort (story points)', 0.5)}
          {num('businessValue', 'Business Value')}
          {num('timeCriticality', 'Time Criticality')}
          {select('activity', 'Activity', ACTIVITIES)}
          {select('valueArea', 'Value Area', VALUE_AREAS)}
          {select('risk', 'Risk', RISKS)}
          {has('blocked') && (
            <Field label="Blocked">
              <select value={get('blocked') ? 'Yes' : 'No'} onChange={(e) => set('blocked', e.target.value === 'Yes')}>
                <option>No</option>
                <option>Yes</option>
              </select>
            </Field>
          )}
        </Section>
        {has('originalEstimate') && (
          <Section title="Effort (hours)">
            {num('originalEstimate', 'Original Estimate', 0.5)}
            {num('remainingWork', 'Remaining Work', 0.5)}
            {num('completedWork', 'Completed Work', 0.5)}
            {roll?.hasChildren && (
              <div className="rollup muted small">
                From child items: {formatHours(roll.remaining)} remaining, {formatHours(roll.completed)} completed, {formatHours(roll.original)} estimated
              </div>
            )}
          </Section>
        )}
        <Section title="Dates">
          {date('startDate', 'Start Date')}
          {date('targetDate', 'Target Date')}
          {date('dueDate', 'Due Date')}
          {due && due < today && item?.state !== 'Done' && <div className="warn small"><Icon name="warning" size={12} /> Past due</div>}
        </Section>
        {(has('foundInBuild') || has('integratedInBuild')) && (
          <Section title="Build">
            <Field label="Found In Build">
              <input value={String(get('foundInBuild') ?? '')} onChange={(e) => set('foundInBuild', e.target.value)} />
            </Field>
            <Field label="Integrated In Build">
              <input value={String(get('integratedInBuild') ?? '')} onChange={(e) => set('integratedInBuild', e.target.value)} />
            </Field>
          </Section>
        )}
        <RelatedWork type={type} item={item} get={get} set={set} />
        {item && <DevelopmentSection item={item} />}
        {item && <InfoSection item={item} />}
      </div>
    </div>
  );
}

function InfoSection({ item }: { item: WorkItem }) {
  return (
    <Section title="Info">
      <div className="small muted info-grid">
        <span>Created</span>
        <span>
          {formatDateTime(item.createdAt)} by {item.createdBy}
        </span>
        <span>Changed</span>
        <span>
          {formatDateTime(item.changedAt)} by {item.changedBy}
        </span>
        {item.closedAt && (
          <>
            <span>Closed</span>
            <span>{formatDateTime(item.closedAt)}</span>
          </>
        )}
      </div>
    </Section>
  );
}

function MiniItem({ item, onRemove, onOpen }: { item: WorkItem; onRemove?: () => void; onOpen: () => void }) {
  return (
    <div className="mini-item">
      <TypeIcon type={item.type} />
      <button className="link-btn mini-title" onClick={onOpen} title={item.title}>
        {item.id} {item.title}
      </button>
      <StateBadge type={item.type} state={item.state} />
      {onRemove && (
        <button className="icon-btn" aria-label="Remove link" onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      )}
    </div>
  );
}

function RelatedWork({ type, item, get, set }: { type: WorkItemType; item?: WorkItem; get: Getter; set: Setter }) {
  const def = TYPE_DEFS[type];
  const itemsById = useItemsById();
  const children = useChildrenMap();
  const { open } = useWorkItemDialog();
  const [pickingParent, setPickingParent] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [childTitle, setChildTitle] = useState('');
  const [childType, setChildType] = useState<WorkItemType | undefined>(def.childTypes[0]);
  const [linkingChild, setLinkingChild] = useState(false);
  const parentId = get('parentId') as number | null;
  const parent = parentId ? itemsById.get(parentId) : undefined;
  const kids = item ? (children.get(item.id) ?? []) : [];

  const addChild = async () => {
    if (!item || !childTitle.trim() || !childType) return;
    await api.createWorkItem(childType, {
      title: childTitle.trim(),
      parentId: item.id,
      iterationId: childType === 'Task' ? item.iterationId : undefined,
      assignedTo: childType === 'Task' ? item.assignedTo : undefined,
    });
    setChildTitle('');
  };

  return (
    <Section title="Related Work">
      {def.parentTypes.length > 0 && (
        <div className="related-group">
          <div className="related-label">
            Parent
            <button className="link-btn small" onClick={() => setPickingParent(!pickingParent)}>
              {parent ? 'Change' : 'Add'}
            </button>
          </div>
          {parent ? <MiniItem item={parent} onOpen={() => open(parent.id)} onRemove={() => set('parentId', null)} /> : <div className="muted small">No parent</div>}
          {pickingParent && (
            <WorkItemPicker
              autoFocus
              types={def.parentTypes}
              exclude={item ? [item.id] : []}
              placeholder={`Find a ${def.parentTypes.join(' or ')}`}
              onPick={(p) => {
                set('parentId', p.id);
                setPickingParent(false);
              }}
            />
          )}
        </div>
      )}
      {def.childTypes.length > 0 && (
        <div className="related-group">
          <div className="related-label">
            Children {kids.length > 0 && <span className="count-pill">{kids.length}</span>}
            {item && (
              <span>
                <button className="link-btn small" onClick={() => setAddingChild(!addingChild)}>
                  New
                </button>
                <button className="link-btn small" onClick={() => setLinkingChild(!linkingChild)}>
                  Existing
                </button>
              </span>
            )}
          </div>
          {!item && <div className="muted small">Save to add child items.</div>}
          {kids.map((k) => (
            <MiniItem key={k.id} item={k} onOpen={() => open(k.id)} onRemove={() => api.updateWorkItem(k.id, { parentId: null })} />
          ))}
          {addingChild && item && (
            <div className="inline-add">
              {def.childTypes.length > 1 && (
                <select value={childType} onChange={(e) => setChildType(e.target.value as WorkItemType)}>
                  {def.childTypes.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              )}
              <input
                autoFocus
                placeholder={`New ${childType} title`}
                value={childTitle}
                onChange={(e) => setChildTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addChild();
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setAddingChild(false);
                  }
                }}
              />
              <button className="btn" onClick={addChild} disabled={!childTitle.trim()}>
                Add
              </button>
            </div>
          )}
          {linkingChild && item && (
            <WorkItemPicker
              autoFocus
              types={def.childTypes}
              exclude={[item.id, ...kids.map((k) => k.id)]}
              onPick={async (c) => {
                await api.updateWorkItem(c.id, { parentId: item.id });
                setLinkingChild(false);
              }}
            />
          )}
        </div>
      )}
      {item && <RelatedLinksSummary item={item} />}
    </Section>
  );
}

function useItemLinks(item: WorkItem) {
  const links = useStore((s) => s.links);
  return useMemo(
    () =>
      links
        .filter((l) => l.sourceId === item.id || l.targetId === item.id)
        .map((l) => ({
          link: l,
          otherId: l.sourceId === item.id ? l.targetId : l.sourceId,
          type: (l.sourceId === item.id ? l.type : LINK_REVERSE[l.type]) as LinkType,
        })),
    [links, item.id],
  );
}

function RelatedLinksSummary({ item }: { item: WorkItem }) {
  const links = useItemLinks(item);
  const itemsById = useItemsById();
  const { open } = useWorkItemDialog();
  const [adding, setAdding] = useState(false);
  return (
    <div className="related-group">
      <div className="related-label">
        Related links {links.length > 0 && <span className="count-pill">{links.length}</span>}
        <button className="link-btn small" onClick={() => setAdding(!adding)}>
          Add link
        </button>
      </div>
      {links.map(({ link, otherId, type }) => {
        const other = itemsById.get(otherId);
        return (
          other && (
            <div key={link.id} className="linked-row">
              <span className="link-type">{type}</span>
              <MiniItem item={other} onOpen={() => open(other.id)} onRemove={() => api.removeLink(link.id)} />
            </div>
          )
        );
      })}
      {adding && <AddLinkForm item={item} onDone={() => setAdding(false)} />}
    </div>
  );
}

function AddLinkForm({ item, onDone }: { item: WorkItem; onDone: () => void }) {
  const [type, setType] = useState<LinkType>('Related');
  const [comment, setComment] = useState('');
  return (
    <div className="add-link">
      <div className="add-link-row">
        <select value={type} onChange={(e) => setType(e.target.value as LinkType)} aria-label="Link type">
          {LINK_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
        <button className="icon-btn" onClick={onDone} aria-label="Cancel">
          <Icon name="close" size={12} />
        </button>
      </div>
      <WorkItemPicker
        autoFocus
        exclude={[item.id]}
        onPick={async (target) => {
          try {
            await api.addLink(item.id, target.id, type, comment);
            onDone();
          } catch {
            // toast shown
          }
        }}
      />
    </div>
  );
}

function Discussion({ item }: { item: WorkItem }) {
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [key, setKey] = useState(0);
  const members = useStore((s) => s.members);
  const currentUser = useStore((s) => s.members.find((m) => m.id === s.currentUserId));
  const post = async () => {
    if (!text.replace(/<[^>]*>|&nbsp;|\s/g, '')) return;
    await api.addComment(item.id, text);
    setText('');
    setKey((k) => k + 1);
  };
  const comments = [...item.comments].reverse();
  return (
    <Section title="Discussion">
      <div id="wi-discussion" className="discussion">
        <div className="comment-new">
          <Avatar member={currentUser} size={28} />
          <div className="comment-editor">
            <RichTextEditor key={key} value={text} onChange={setText} placeholder="Add a comment" minHeight={50} />
            <button className="btn btn-primary" onClick={post} disabled={!text.replace(/<[^>]*>|&nbsp;|\s/g, '')}>
              Comment
            </button>
          </div>
        </div>
        {comments.map((c) => (
          <div key={c.id} className="comment">
            <Avatar member={members.find((m) => m.name === c.author)} size={28} />
            <div className="comment-body">
              <div className="comment-meta">
                <strong>{c.author}</strong>
                <span className="muted" title={formatDateTime(c.createdAt)}>
                  commented {timeAgo(c.createdAt)}
                  {c.editedAt && ' (edited)'}
                </span>
                {currentUser?.name === c.author && editing !== c.id && (
                  <span className="comment-actions">
                    <button
                      className="icon-btn"
                      aria-label="Edit comment"
                      onClick={() => {
                        setEditing(c.id);
                        setEditText(c.text);
                      }}
                    >
                      <Icon name="edit" size={12} />
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="Delete comment"
                      onClick={async () => {
                        if (await confirmDialog({ title: 'Delete comment?', message: 'This cannot be undone.', confirmLabel: 'Delete', danger: true })) {
                          await api.deleteComment(item.id, c.id);
                        }
                      }}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                )}
              </div>
              {editing === c.id ? (
                <div className="comment-editor">
                  <RichTextEditor value={editText} onChange={setEditText} minHeight={50} autoFocus />
                  <div className="row gap">
                    <button
                      className="btn btn-primary"
                      onClick={async () => {
                        await api.editComment(item.id, c.id, editText);
                        setEditing(null);
                      }}
                    >
                      Update
                    </button>
                    <button className="btn" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <RichView html={c.text} />
              )}
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function HistoryTab({ item }: { item: WorkItem }) {
  const members = useStore((s) => s.members);
  const sprints = useStore((s) => s.sprints);
  const itemsById = useItemsById();
  const lookup = { members, sprints, itemsById };
  const entries = [...item.history].reverse();
  const [selected, setSelected] = useState(entries[0]?.id);
  const current = entries.find((e) => e.id === selected) ?? entries[0];
  return (
    <div className="history">
      <div className="history-list">
        {entries.map((e) => (
          <button key={e.id} className={`history-entry ${e.id === current?.id ? 'active' : ''}`} onClick={() => setSelected(e.id)}>
            <Avatar member={members.find((m) => m.name === e.changedBy)} size={24} />
            <div>
              <div className="history-who">{e.changedBy}</div>
              <div className="muted small">
                {e.note ?? (e.changes.length === 1 ? `Changed ${FIELD_LABELS[e.changes[0].field] ?? e.changes[0].field}` : `Changed ${e.changes.length} fields`)}
              </div>
              <div className="muted small">{timeAgo(e.changedAt)}</div>
            </div>
          </button>
        ))}
      </div>
      <div className="history-detail">
        {current && (
          <>
            <div className="history-detail-head">
              <strong>{current.changedBy}</strong> <span className="muted">{formatDateTime(current.changedAt)}</span>
              {current.note && <div>{current.note}</div>}
            </div>
            <table className="history-table">
              <tbody>
                {current.changes.map((c, i) => (
                  <tr key={i}>
                    <th>{FIELD_LABELS[c.field] ?? c.field}</th>
                    <td>
                      {HTML_FIELDS.has(c.field) ? (
                        <div className="html-change">
                          {c.oldValue ? (
                            <div className="old">
                              <RichView html={String(c.oldValue)} />
                            </div>
                          ) : null}
                          <div className="new">
                            <RichView html={String(c.newValue ?? '')} empty="(cleared)" />
                          </div>
                        </div>
                      ) : (
                        <>
                          {c.oldValue !== null && c.oldValue !== '' && <span className="old">{formatFieldValue(c.field, c.oldValue, lookup)}</span>}
                          {c.oldValue !== null && c.oldValue !== '' && <Icon name="chevronRight" size={12} />}
                          <span className="new">{formatFieldValue(c.field, c.newValue, lookup) || '(cleared)'}</span>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {current.changes.length === 0 && !current.note && <div className="muted">No field changes</div>}
          </>
        )}
      </div>
    </div>
  );
}

function LinksTab({ item }: { item: WorkItem }) {
  const links = useItemLinks(item);
  const itemsById = useItemsById();
  const children = useChildrenMap();
  const { open } = useWorkItemDialog();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState('');
  const [comment, setComment] = useState('');
  const parent = item.parentId ? itemsById.get(item.parentId) : undefined;
  const kids = children.get(item.id) ?? [];
  const groups = new Map<string, { id: string; other: WorkItem; comment: string; remove: () => void }[]>();
  if (parent) groups.set('Parent', [{ id: 'parent', other: parent, comment: '', remove: () => api.updateWorkItem(item.id, { parentId: null }) }]);
  if (kids.length) groups.set('Child', kids.map((k) => ({ id: `c${k.id}`, other: k, comment: '', remove: () => api.updateWorkItem(k.id, { parentId: null }) })));
  for (const l of links) {
    const other = itemsById.get(l.otherId);
    if (!other) continue;
    const list = groups.get(l.type) ?? [];
    list.push({ id: l.link.id, other, comment: l.link.comment, remove: () => api.removeLink(l.link.id) });
    groups.set(l.type, list);
  }
  return (
    <div className="links-tab">
      <div className="row gap">
        <button className="btn" onClick={() => setAdding(!adding)}>
          <Icon name="add" size={12} /> Add link
        </button>
      </div>
      {adding && <AddLinkForm item={item} onDone={() => setAdding(false)} />}
      {groups.size === 0 && <div className="muted pad">No work item links yet.</div>}
      {[...groups].map(([name, list]) => (
        <div key={name} className="link-group">
          <h4>
            {name} ({list.length})
          </h4>
          <table className="grid">
            <tbody>
              {list.map((r) => (
                <tr key={r.id}>
                  <td className="cell-type">
                    <TypeIcon type={r.other.type} />
                  </td>
                  <td>
                    <button className="link-btn" onClick={() => open(r.other.id)}>
                      {r.other.id} {r.other.title}
                    </button>
                    {r.comment && <div className="muted small">{r.comment}</div>}
                  </td>
                  <td>
                    <StateBadge type={r.other.type} state={r.other.state} />
                  </td>
                  <td className="muted small">Updated {timeAgo(r.other.changedAt)}</td>
                  <td>
                    <button className="icon-btn" aria-label="Remove link" onClick={r.remove}>
                      <Icon name="trash" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <div className="link-group">
        <h4>Hyperlinks ({item.hyperlinks.length})</h4>
        {item.hyperlinks.map((h) => (
          <div key={h.id} className="hyperlink-row">
            <Icon name="link" size={14} />
            <a href={h.url} target="_blank" rel="noopener noreferrer">
              {h.url}
            </a>
            {h.comment && <span className="muted small">{h.comment}</span>}
            <button className="icon-btn" aria-label="Remove hyperlink" onClick={() => api.removeHyperlink(item.id, h.id)}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        <form
          className="add-link-row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.addHyperlink(item.id, url.trim(), comment);
              setUrl('');
              setComment('');
            } catch {
              // toast shown
            }
          }}
        >
          <input type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} required aria-label="Hyperlink URL" />
          <input placeholder="Comment (optional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <button className="btn" type="submit" disabled={!url.trim()}>
            Add hyperlink
          </button>
        </form>
      </div>
    </div>
  );
}
