import type { WorkItemType } from '../process.ts';

export type WorkItemEvent =
  | { readonly type: 'WorkItemCreated'; readonly workItemId: number; readonly workItemType: WorkItemType; readonly occurredAt: Date }
  | { readonly type: 'WorkItemChanged'; readonly workItemId: number; readonly fields: readonly string[]; readonly occurredAt: Date }
  | { readonly type: 'WorkItemRestored'; readonly workItemId: number; readonly occurredAt: Date }
  | { readonly type: 'CommentAdded'; readonly workItemId: number; readonly commentId: string; readonly occurredAt: Date }
  | { readonly type: 'CommentEdited'; readonly workItemId: number; readonly commentId: string; readonly occurredAt: Date }
  | { readonly type: 'CommentDeleted'; readonly workItemId: number; readonly commentId: string; readonly occurredAt: Date }
  | { readonly type: 'HyperlinkAdded'; readonly workItemId: number; readonly hyperlinkId: string; readonly occurredAt: Date }
  | { readonly type: 'HyperlinkRemoved'; readonly workItemId: number; readonly hyperlinkId: string; readonly occurredAt: Date }
  | { readonly type: 'DevLinkAdded'; readonly workItemId: number; readonly devLinkId: string; readonly occurredAt: Date }
  | { readonly type: 'DevLinkUpdated'; readonly workItemId: number; readonly devLinkId: string; readonly occurredAt: Date }
  | { readonly type: 'DevLinkRemoved'; readonly workItemId: number; readonly devLinkId: string; readonly occurredAt: Date };
