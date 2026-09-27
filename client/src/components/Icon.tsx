import type { WorkItemType } from '../../../shared/process';
import { TYPE_DEFS } from '../../../shared/process';

const PATHS: Record<string, string> = {
  add: 'M8 2v12M2 8h12',
  chevronDown: 'M3.5 6l4.5 4.5L12.5 6',
  chevronRight: 'M6 3.5l4.5 4.5L6 12.5',
  chevronLeft: 'M10 3.5L5.5 8l4.5 4.5',
  more: 'M3 8h.01M8 8h.01M13 8h.01',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  filter: 'M2 3h12L9.5 8.5V13l-3-1.5v-3z',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5L14 14',
  settings: 'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M3 13l1.5-1.5M11.5 4.5L13 3',
  board: 'M2 2.5h3.5v11H2zM6.25 2.5h3.5v7h-3.5zM10.5 2.5H14v9h-3.5z',
  backlog: 'M2 3.5h12M2 6.5h12M2 9.5h12M2 12.5h8',
  sprint: 'M2 8a6 6 0 1 1 1.76 4.24M2 8V4.5M2 8h3.5',
  workitems: 'M3 2h10v12H3zM5.5 5h5M5.5 8h5M5.5 11h3',
  trash: 'M3 4h10M6.5 4V2.5h3V4M4.5 4l.7 9.5h5.6l.7-9.5',
  copy: 'M5 5h8v9H5zM3 11V2h8',
  link: 'M6.5 9.5l3-3M7 4.5l1.3-1.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.3 1.3a2.5 2.5 0 0 1-3.5-3.5L5.5 8',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5M8 5v3l2 1.5',
  comment: 'M2 3h12v8H6l-3 2.5V11H2z',
  save: 'M2.5 2.5h9l2 2v9h-11zM5 2.5v3.5h5V2.5M5 13.5v-4h6v4',
  drag: 'M6 3h.01M10 3h.01M6 8h.01M10 8h.01M6 13h.01M10 13h.01',
  branch: 'M5 3v7.5M5 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11 6c0 3-6 2-6 4.5',
  pullRequest: 'M4.5 4.5v7M4.5 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4.5 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 14.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM11.5 11.5V5.5a2 2 0 0 0-2-2H7M8.5 2l-1.5 1.5L8.5 5',
  commit: 'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 8h4M10.5 8h4',
  github: 'M8 1.5a6.5 6.5 0 0 0-2 12.7c.3 0 .4-.1.4-.3v-1.2c-1.8.4-2.2-.8-2.2-.8-.3-.8-.7-1-.7-1-.6-.4 0-.4 0-.4.6 0 1 .7 1 .7.6 1 1.5.7 1.9.5 0-.4.2-.7.4-.9-1.4-.2-3-.7-3-3.2 0-.7.3-1.3.7-1.7-.1-.2-.3-.8 0-1.7 0 0 .6-.2 1.8.7a6 6 0 0 1 3.2 0c1.2-.9 1.8-.7 1.8-.7.3.9.1 1.5 0 1.7.4.4.7 1 .7 1.7 0 2.5-1.5 3-3 3.2.3.2.5.6.5 1.2v1.8c0 .2.1.4.4.3A6.5 6.5 0 0 0 8 1.5z',
  lock: 'M3.5 7h9v7h-9zM5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 10v1.5',
  calendar: 'M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3',
  people: 'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4M11 7a2 2 0 1 0 0-4M12 9.5c1.3.5 2.2 1.8 2.5 3.5',
  chart: 'M2 14h12M4 12V8M7 12V4M10 12V6M13 12V9',
  backup: 'M8 2c3.3 0 6 1.1 6 2.5S11.3 7 8 7 2 5.9 2 4.5 4.7 2 8 2zM2 4.5v7C2 12.9 4.7 14 8 14s6-1.1 6-2.5v-7M2 8c0 1.4 2.7 2.5 6 2.5S14 9.4 14 8',
  restore: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5',
  download: 'M8 2v8.5M4.5 7L8 10.5 11.5 7M2.5 13.5h11',
  upload: 'M8 11V2.5M4.5 6L8 2.5 11.5 6M2.5 13.5h11',
  check: 'M3 8.5l3 3 7-7',
  warning: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5h.01',
  list: 'M5 4h9M5 8h9M5 12h9M2 4h.01M2 8h.01M2 12h.01',
  undo: 'M4.5 6.5H10a3.5 3.5 0 0 1 0 7H6M4.5 6.5L7 4M4.5 6.5L7 9',
  edit: 'M10.5 2.5l3 3L6 13H3v-3z',
  open: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4',
  pane: 'M2 2.5h12v11H2zM10 2.5v11',
  person: 'M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5zM2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
  moveTop: 'M3 2.5h10M8 13.5V5.5M4.5 9L8 5.5 11.5 9',
  bold: 'M4.5 2.5h4a2.75 2.75 0 0 1 0 5.5h-4zM4.5 8h5a2.75 2.75 0 0 1 0 5.5h-5z',
  italic: 'M6.5 2.5h6M3.5 13.5h6M10 2.5l-4 11',
  underline: 'M4.5 2v5.5a3.5 3.5 0 0 0 7 0V2M3.5 14h9',
  strike: 'M2.5 8h11M11 4.5C10.5 3 9.4 2.5 8 2.5c-1.9 0-3.2 1-3.2 2.4M5 11.5c.5 1.5 1.6 2 3 2 1.9 0 3.2-1 3.2-2.5',
  ul: 'M6 4h8M6 8h8M6 12h8M2.5 4h.01M2.5 8h.01M2.5 12h.01',
  ol: 'M6 4h8M6 8h8M6 12h8M2 3l1-.5V6M2 9.5h1.5L2 11.5h1.5',
  code: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5',
  clear: 'M3 13.5h10M4.5 2.5h8M8.5 2.5l-3 8',
  expandAll: 'M4 6l4 4 4-4',
  collapseAll: 'M4 10l4-4 4 4',
  fullscreen: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  target: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  blocked: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM3.8 3.8l8.4 8.4',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className, title }: { name: IconName | string; size?: number; className?: string; title?: string }) {
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' || name === 'drag' ? 2.5 : 1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      <path d={PATHS[name] ?? PATHS.workitems} />
    </svg>
  );
}

const TYPE_GLYPHS: Record<WorkItemType, string> = {
  // crown
  Epic: 'M2 12.5h12L13 5l-3 3-2-4.5L6 8 3 5z',
  // trophy
  Feature: 'M5 2.5h6v3.5a3 3 0 0 1-6 0zM5 3.5H2.5v1a2.5 2.5 0 0 0 2.6 2.5M11 3.5h2.5v1a2.5 2.5 0 0 1-2.6 2.5M8 9v3M5.5 13.5h5',
  // book
  'Product Backlog Item': 'M3 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12zM3 12a1.5 1.5 0 0 1 1.5-1.5H12',
  // bug
  Bug: 'M5.5 6a2.5 2.5 0 0 1 5 0v4a2.5 2.5 0 0 1-5 0zM5.5 8H2.5M13.5 8h-3M3 4.5l2.5 2M13 4.5l-2.5 2M3 12.5l2.5-2M13 12.5l-2.5-2M6.5 3.5L5.5 2M9.5 3.5l1-1.5',
  // clipboard
  Task: 'M4 3h8v11H4zM6 2h4v2H6zM6 7.5l1.3 1.3L10 6.3M6 11h4',
};

export function TypeIcon({ type, size = 16 }: { type: WorkItemType; size?: number }) {
  const color = TYPE_DEFS[type].color;
  return (
    <svg className="type-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-label={type} role="img">
      <path d={TYPE_GLYPHS[type]} fill={type === 'Epic' ? color : 'none'} fillOpacity={type === 'Epic' ? 0.25 : undefined} />
    </svg>
  );
}
