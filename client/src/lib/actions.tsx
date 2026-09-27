import { useState } from 'react';
import { TYPE_DEFS, type WorkItemType } from '../../../shared/process';
import { nextSprint, sprintTimeframe } from '../../../shared/sprints';
import type { Sprint, WorkItem } from '../../../shared/types';
import { api } from '../api';
import { Modal, confirmDialog, type MenuItem } from '../components/common';
import { WorkItemPicker } from '../components/inputs';
import { useWorkItemDialog } from '../components/WorkItemForm';
import { toast, useStore } from '../store';
import { useSortedSprints, useToday } from './hooks';

export interface ItemMenuOptions {
  /** Called to add a child inline; falls back to opening a new-item form. */
  onAddChild?: (parent: WorkItem, type: WorkItemType) => void;
  /** Show "Move to top/bottom" entries, ordering relative to these items. */
  reorderWithin?: WorkItem[];
  /** The sprint being viewed: adds quick "Move to next sprint" and "Move to backlog" entries. */
  sprint?: Sprint;
}

/** Context menu entries shared by the backlog, boards and sprint views. */
export function useItemMenu() {
  const { open, openNew } = useWorkItemDialog();
  const sprints = useSortedSprints();
  const members = useStore((s) => s.members);
  const projectName = useStore((s) => s.settings.projectName);
  const today = useToday();
  const [parentFor, setParentFor] = useState<WorkItem[] | null>(null);

  const build = (selection: WorkItem[], opts: ItemMenuOptions = {}): MenuItem[] => {
    if (!selection.length) return [];
    const single = selection.length === 1 ? selection[0] : null;
    const ids = selection.map((w) => w.id);
    const types = [...new Set(selection.map((w) => w.type))];
    const commonStates = types
      .map((t) => TYPE_DEFS[t].states.map((s) => s.name))
      .reduce((acc, list) => acc.filter((s) => list.includes(s)));
    const parentTypes = types.map((t) => TYPE_DEFS[t].parentTypes).reduce((acc, list) => acc.filter((t) => list.includes(t)));
    const menu: MenuItem[] = [];

    if (single) {
      menu.push({ label: 'Open', icon: 'open', onClick: () => open(single.id) });
      const childTypes = TYPE_DEFS[single.type].childTypes;
      if (childTypes.length) {
        menu.push({
          label: 'Add child',
          icon: 'add',
          submenu: childTypes.map((t) => ({
            label: t,
            onClick: () => (opts.onAddChild ? opts.onAddChild(single, t) : openNew(t, { parentId: single.id, iterationId: t === 'Task' ? single.iterationId : null })),
          })),
        });
      }
      menu.push({ divider: true });
    }

    if (opts.reorderWithin?.length) {
      const ordered = [...opts.reorderWithin].sort((a, b) => a.stackRank - b.stackRank);
      const others = ordered.filter((w) => !ids.includes(w.id));
      menu.push(
        {
          label: 'Move to top',
          icon: 'moveTop',
          disabled: !others.length,
          onClick: async () => {
            for (const w of [...selection].sort((a, b) => b.stackRank - a.stackRank)) await api.moveWorkItem(w.id, { beforeId: others[0].id });
          },
        },
        {
          label: 'Move to bottom',
          icon: 'chevronDown',
          disabled: !others.length,
          onClick: async () => {
            for (const w of [...selection].sort((a, b) => a.stackRank - b.stackRank)) await api.moveWorkItem(w.id, { afterId: others[others.length - 1].id });
          },
        },
      );
    }

    if (opts.sprint) {
      const next = nextSprint(sprints, opts.sprint);
      menu.push(
        {
          label: next ? `Move to next sprint (${next.name})` : 'Move to next sprint (none planned yet)',
          icon: 'sprint',
          disabled: !next,
          onClick: () => next && moveTo(ids, next.id),
        },
        { label: 'Move to backlog', icon: 'backlog', onClick: () => moveTo(ids, null) },
      );
    }
    menu.push({
      label: opts.sprint ? 'Move to another iteration' : 'Move to iteration',
      icon: 'sprint',
      submenu: [
        { label: `${projectName} (Backlog)`, checked: selection.every((w) => !w.iterationId), onClick: () => moveTo(ids, null) },
        { divider: true },
        ...sprints
          .filter((s) => sprintTimeframe(s, today) !== 'past' || selection.some((w) => w.iterationId === s.id))
          .map((s) => ({
            label: `${s.name}${sprintTimeframe(s, today) === 'current' ? ' (Current)' : ''}`,
            checked: selection.every((w) => w.iterationId === s.id),
            onClick: () => moveTo(ids, s.id),
          })),
      ],
    });
    menu.push({
      label: 'Assign to',
      icon: 'person',
      submenu: [
        { label: 'Unassigned', checked: selection.every((w) => !w.assignedTo), onClick: () => api.bulkUpdate(ids, { assignedTo: null }) },
        { divider: true },
        ...members
          .filter((m) => m.active)
          .map((m) => ({ label: m.name, checked: selection.every((w) => w.assignedTo === m.id), onClick: () => api.bulkUpdate(ids, { assignedTo: m.id }) })),
      ],
    });
    if (commonStates.length) {
      menu.push({
        label: 'Change state',
        icon: 'check',
        submenu: commonStates.map((s) => ({ label: s, checked: selection.every((w) => w.state === s), onClick: () => api.bulkUpdate(ids, { state: s }) })),
      });
    }
    if (parentTypes.length) {
      menu.push({ label: 'Change parent…', icon: 'link', onClick: () => setParentFor(selection) });
    }
    menu.push({ divider: true });
    if (single) {
      menu.push({
        label: 'Copy link',
        icon: 'link',
        onClick: () => {
          const url = new URL(window.location.href);
          url.search = `?wi=${single.id}`;
          void navigator.clipboard?.writeText(url.toString());
          toast('Link copied to clipboard');
        },
      });
      menu.push({ label: 'Create copy', icon: 'copy', onClick: async () => open((await api.copyWorkItem(single.id, false)).id) });
    }
    menu.push({
      label: selection.length > 1 ? `Delete ${selection.length} items` : 'Delete',
      icon: 'trash',
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({
          title: selection.length > 1 ? `Delete ${selection.length} work items?` : `Delete ${single!.type} ${single!.id}?`,
          message: 'Deleted items go to the recycle bin (Project settings) and can be restored. Child items are kept but unparented.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await api.deleteWorkItems(ids);
        toast(selection.length > 1 ? `${selection.length} work items deleted` : `${single!.type} ${single!.id} deleted`);
      },
    });
    return menu;
  };

  const moveTo = async (ids: number[], iterationId: string | null) => {
    await api.bulkUpdate(ids, { iterationId });
    const name = iterationId ? sprints.find((s) => s.id === iterationId)?.name : 'the backlog';
    // The server moves a backlog item's open tasks along with it.
    toast(`Moved ${ids.length === 1 ? `#${ids[0]}` : `${ids.length} items`} to ${name}`, 'success');
  };

  const element = parentFor && <ChangeParentModal items={parentFor} onClose={() => setParentFor(null)} />;
  return { build, element, moveTo };
}

function ChangeParentModal({ items, onClose }: { items: WorkItem[]; onClose: () => void }) {
  const allowed = items
    .map((w) => TYPE_DEFS[w.type].parentTypes)
    .reduce((acc, list) => acc.filter((t) => list.includes(t)));
  return (
    <Modal title={`Change parent of ${items.length === 1 ? `#${items[0].id}` : `${items.length} items`}`} onClose={onClose} width={520}>
      <WorkItemPicker
        autoFocus
        types={allowed}
        exclude={items.map((w) => w.id)}
        placeholder={`Find a ${allowed.join(' or ')}`}
        onPick={async (p) => {
          await api.bulkUpdate(
            items.map((w) => w.id),
            { parentId: p.id },
          );
          toast(`Parent set to #${p.id}`, 'success');
          onClose();
        }}
      />
      <div className="row gap pad-t">
        <button
          className="btn"
          onClick={async () => {
            await api.bulkUpdate(
              items.map((w) => w.id),
              { parentId: null },
            );
            onClose();
          }}
        >
          Remove parent
        </button>
      </div>
    </Modal>
  );
}
