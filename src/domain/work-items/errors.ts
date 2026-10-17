import type { WorkItemType } from '../process.ts';
import type { CommentError } from './comments.ts';
import type { FieldError } from './fields.ts';
import type { HyperlinkError } from './hyperlinks.ts';
import type { WorkItemIdError } from './ids.ts';

/** Every way a work item rule can refuse a change. Plain data, keyed by `code`. */
export type WorkItemError =
  | FieldError
  | WorkItemIdError
  | CommentError
  | HyperlinkError
  | { readonly code: 'UNKNOWN_WORK_ITEM_TYPE'; readonly type: string }
  | { readonly code: 'WORK_ITEM_NOT_FOUND'; readonly id: number }
  | { readonly code: 'INVALID_STATE'; readonly state: string; readonly type: WorkItemType }
  | { readonly code: 'SPRINT_NOT_FOUND'; readonly id: string }
  | { readonly code: 'MEMBER_NOT_FOUND'; readonly id: string }
  | { readonly code: 'SELF_PARENT' }
  | { readonly code: 'PARENT_TYPE_NOT_ALLOWED'; readonly parentType: WorkItemType; readonly childType: WorkItemType }
  | { readonly code: 'CIRCULAR_HIERARCHY' }
  | { readonly code: 'ITEM_TAG_LIMIT'; readonly id: number; readonly max: number };
