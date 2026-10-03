import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { stateDef, type WorkItemType } from '../../../shared/process';
import type { Member, WorkItem } from '../../../shared/types';
import { api } from '../api';
import { initials } from '../lib/format';
import { useMembersById } from '../lib/hooks';
import { dismissToast, useStore } from '../store';
import { Icon } from './Icon';

export function StateBadge({ type, state }: { type: WorkItemType; state: string }) {
  const def = stateDef(type, state);
  const color = def?.color ?? '#b2b2b2';
  return (
    <span className="state-badge">
      <span className="state-dot" style={{ background: color, borderColor: color === '#ffffff' ? '#999' : color }} />
      {state}
    </span>
  );
}

export function Avatar({ member, size = 24 }: { member: Member | null | undefined; size?: number }) {
  if (!member) {
    return (
      <span className="avatar avatar-empty" style={{ width: size, height: size }}>
        <Icon name="person" size={Math.round(size * 0.6)} />
      </span>
    );
  }
  return (
    <span className="avatar" title={member.name} style={{ width: size, height: size, background: member.color, fontSize: Math.round(size * 0.42) }}>
      {initials(member.name)}
    </span>
  );
}

export function Person({ id, size = 20, showName = true }: { id: string | null | undefined; size?: number; showName?: boolean }) {
  const members = useMembersById();
  const member = id ? members.get(id) : null;
  return (
    <span className="person">
      <Avatar member={member} size={size} />
      {showName && <span className={member ? 'person-name' : 'person-name muted'}>{member?.name ?? 'Unassigned'}</span>}
    </span>
  );
}

/**
 * The assignee on a card, as a button that opens a short list to change it straight away:
 * Unassigned and the active team members. Clicking it doesn't open the item or start a drag.
 */
export function AssigneePicker({ item, size = 18 }: { item: WorkItem; size?: number }) {
  const members = useStore((s) => s.members);
  const byId = useMembersById();
  const menu = useMenu();
  const current = item.assignedTo ?? null;
  const name = (current && byId.get(current)?.name) || 'Unassigned';
  const choose = (id: string | null) => {
    if (id !== current) void api.updateWorkItem(item.id, { assignedTo: id });
  };
  return (
    <>
      <button
        type="button"
        className="person-btn"
        title="Change who it's assigned to"
        aria-label={`Assigned to ${name}. Change`}
        aria-haspopup="menu"
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        onDoubleClick={(e) => e.stopPropagation()}
        onClick={(e) =>
          menu.openAt(e, [
            { label: 'Unassigned', checked: !current, onClick: () => choose(null) },
            ...members.filter((m) => m.active || m.id === current).map((m) => ({ label: m.name, checked: current === m.id, onClick: () => choose(m.id) })),
          ])
        }
      >
        <Person id={current} size={size} />
      </button>
      {menu.element}
    </>
  );
}

export function Tags({ tags, max = 4 }: { tags: string[]; max?: number }) {
  if (!tags.length) return null;
  return (
    <span className="tags">
      {tags.slice(0, max).map((t) => (
        <span key={t} className="tag">
          {t}
        </span>
      ))}
      {tags.length > max && <span className="tag tag-more">+{tags.length - max}</span>}
    </span>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'warning' : 'check'} />
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${className ?? ''}`} style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

interface ConfirmState {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

let showConfirm: ((s: ConfirmState) => void) | null = null;

/** Promise-based confirmation dialog. */
export function confirmDialog(opts: { title: string; message: ReactNode; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!showConfirm) return resolve(window.confirm(String(opts.message)));
    showConfirm({ confirmLabel: 'OK', danger: false, ...opts, resolve });
  });
}

export function ConfirmHost() {
  const [state, setState] = useState<ConfirmState | null>(null);
  useEffect(() => {
    showConfirm = setState;
    return () => {
      showConfirm = null;
    };
  }, []);
  if (!state) return null;
  const close = (ok: boolean) => {
    state.resolve(ok);
    setState(null);
  };
  return (
    <Modal
      title={state.title}
      onClose={() => close(false)}
      width={440}
      footer={
        <>
          <button className={state.danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={() => close(true)} autoFocus>
            {state.confirmLabel}
          </button>
          <button className="btn" onClick={() => close(false)}>
            Cancel
          </button>
        </>
      }
    >
      <div className="confirm-message">{state.message}</div>
    </Modal>
  );
}

export interface MenuItem {
  label?: string;
  icon?: string;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  submenu?: MenuItem[];
  checked?: boolean;
}

/** A dropdown/context menu rendered at a fixed viewport position. */
export function MenuPopup({ items, x, y, onClose }: { items: MenuItem[]; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  // Which item's submenu is open, and where that item is on screen.
  const [open, setOpen] = useState<{ idx: number; anchor: DOMRect } | null>(null);
  // Keyboard: the menu takes focus (the checked item, else the first), arrow keys move through
  // it, and closing gives focus back to what opened it unless something else took it.
  const back = useRef<Element | null>(document.activeElement);
  const buttons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>(':scope > .menu-item-wrap > .menu-item:not(:disabled)') ?? [])];
  useEffect(() => {
    const list = buttons();
    (list.find((b) => b.dataset.checked === 'true') ?? list[0])?.focus({ preventScroll: true });
    const opener = back.current;
    return () => {
      requestAnimationFrame(() => {
        const a = document.activeElement;
        if (opener instanceof HTMLElement && document.contains(opener) && (!a || a === document.body)) opener.focus({ preventScroll: true });
      });
    };
  }, []);
  const onMenuKey = (e: React.KeyboardEvent) => {
    const list = buttons();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (k: number) => {
      e.preventDefault();
      list[(k + list.length) % list.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? list.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Tab') onClose();
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 8)),
      y: Math.max(4, y + r.height > window.innerHeight - 8 ? Math.max(4, y - r.height) : y),
    });
  }, [x, y]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.menu')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const onScroll = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.('.menu')) onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="menu" style={{ left: pos.x, top: pos.y }} role="menu" onKeyDown={onMenuKey}>
      {items.map((item, idx) =>
        item.divider ? (
          <div key={idx} className="menu-divider" />
        ) : (
          <div
            key={idx}
            className="menu-item-wrap"
            onMouseEnter={(e) => setOpen(item.submenu && !item.disabled ? { idx, anchor: e.currentTarget.getBoundingClientRect() } : null)}
          >
            <button
              className={`menu-item ${item.danger ? 'danger' : ''} ${open?.idx === idx ? 'open' : ''}`}
              disabled={item.disabled}
              role={item.checked != null ? 'menuitemradio' : 'menuitem'}
              aria-checked={item.checked != null ? item.checked : undefined}
              data-checked={item.checked ? 'true' : undefined}
              aria-haspopup={item.submenu ? 'menu' : undefined}
              aria-expanded={item.submenu ? open?.idx === idx : undefined}
              onClick={(e) => {
                if (item.submenu) return setOpen({ idx, anchor: (e.currentTarget.parentElement ?? e.currentTarget).getBoundingClientRect() });
                item.onClick?.();
                onClose();
              }}
            >
              <span className="menu-icon">{item.checked ? <Icon name="check" size={14} /> : item.icon ? <Icon name={item.icon} size={14} /> : null}</span>
              <span className="menu-label">{item.label}</span>
              {item.submenu && <Icon name="chevronRight" size={12} />}
            </button>
            {item.submenu && open?.idx === idx && <Submenu items={item.submenu} anchor={open.anchor} onClose={onClose} />}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * A submenu floats beside its parent item. It is positioned on screen rather than inside the
 * parent menu, which scrolls and would otherwise clip it; it flips left when there's no room.
 */
function Submenu({ items, anchor, onClose }: { items: MenuItem[]; anchor: DOMRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = anchor.right + r.width <= window.innerWidth - 8 ? anchor.right - 2 : Math.max(4, anchor.left - r.width + 2);
    const y = Math.max(4, Math.min(anchor.top - 4, window.innerHeight - r.height - 8));
    setPos({ x, y });
  }, [anchor]);
  return (
    <div ref={ref} className="menu submenu" role="menu" style={{ left: pos?.x ?? anchor.right, top: pos?.y ?? anchor.top, visibility: pos ? 'visible' : 'hidden' }}>
      {items.map((sub, j) =>
        sub.divider ? (
          <div key={j} className="menu-divider" />
        ) : (
          <button
            key={j}
            className="menu-item"
            role="menuitem"
            disabled={sub.disabled}
            onClick={() => {
              sub.onClick?.();
              onClose();
            }}
          >
            <span className="menu-icon">{sub.checked ? <Icon name="check" size={14} /> : sub.icon ? <Icon name={sub.icon} size={14} /> : null}</span>
            <span className="menu-label">{sub.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

/** Hook for opening a menu at the mouse position or anchored under a button. */
export function useMenu() {
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null);
  const openAt = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'contextmenu') return setMenu({ items, x: e.clientX, y: e.clientY });
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ items, x: r.left, y: r.bottom + 2 });
  };
  const element = menu ? <MenuPopup {...menu} onClose={() => setMenu(null)} /> : null;
  return { openAt, element };
}

/** Simple multi-select dropdown used by filter bars. */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: string; label: ReactNode }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="multiselect" ref={ref}>
      <button className={`filter-btn ${value.length ? 'active' : ''}`} onClick={() => setOpen(!open)}>
        {label}
        {value.length > 0 && <span className="count-pill">{value.length}</span>}
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div className="multiselect-popup">
          {options.length === 0 && <div className="muted small pad">No options</div>}
          {options.map((o) => (
            <label key={o.value} className="check-row">
              <input type="checkbox" checked={value.includes(o.value)} onChange={() => toggle(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
          {value.length > 0 && (
            <button className="link-btn small pad" onClick={() => onChange([])}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function EmptyState({ icon = 'workitems', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon name={icon} size={40} />
      <h3>{title}</h3>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function ProgressBar({ value, max, label, over }: { value: number; max: number; label?: ReactNode; over?: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : value > 0 ? 100 : 0;
  const isOver = over ?? value > max;
  return (
    <div className="progress">
      {label && <div className="progress-label">{label}</div>}
      <div className="progress-track">
        <div className={`progress-fill ${isOver ? 'over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
