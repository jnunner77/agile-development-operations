// Native HTML5 drag & drop can't read dataTransfer contents during dragover, so the
// dragged work item ids are kept here for drop targets to inspect.

let dragged: number[] = [];

export function startDrag(e: React.DragEvent, ids: number[]) {
  dragged = ids;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', ids.map((id) => `#${id}`).join(', '));
}

export function draggedIds() {
  return dragged;
}

export function endDrag() {
  dragged = [];
}

/** Whether the pointer is in the top half of the element (drop before) or bottom half (drop after). */
export function dropPosition(e: React.DragEvent): 'before' | 'after' {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}
