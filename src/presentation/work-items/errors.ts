import type { WorkItemsError } from '#application/work-items/deps.ts';
import { assertNever } from '#shared/result.ts';

export interface HttpFailure {
  readonly status: number;
  readonly message: string;
}

/** "dueDate" -> "Due date". */
function label(field: string): string {
  const words = field.replace(/([A-Z])/g, ' $1').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The HTTP status and message for every error the work item use cases can return. Adding an
 * error code to the domain fails the build here until it has a status.
 */
export function httpFailure(error: WorkItemsError): HttpFailure {
  switch (error.code) {
    case 'TITLE_REQUIRED':
      return { status: 400, message: 'Title is required' };
    case 'TEXT_TOO_LONG':
      return { status: 400, message: error.field === 'tags' ? `Tags must be at most ${error.max} characters` : `${label(error.field)} must be at most ${error.max} characters` };
    case 'NUMBER_OUT_OF_RANGE':
      return { status: 400, message: `${label(error.field)} must be between ${error.min} and ${error.max}` };
    case 'NOT_AN_INTEGER':
      return { status: 400, message: `${label(error.field)} must be a whole number` };
    case 'INVALID_DATE':
      return { status: 400, message: `${label(error.field)}: Expected a date in YYYY-MM-DD format` };
    case 'TAG_EMPTY':
      return { status: 400, message: 'Tags cannot be empty' };
    case 'TOO_MANY_TAGS':
      return { status: 400, message: `At most ${error.max} tags are allowed` };
    case 'INVALID_WORK_ITEM_ID':
      return { status: 400, message: 'Invalid id' };
    case 'UNKNOWN_WORK_ITEM_TYPE':
      return { status: 400, message: `Unknown work item type "${error.type}"` };
    case 'WORK_ITEM_NOT_FOUND':
      return { status: 404, message: `Work item ${error.id} not found` };
    case 'INVALID_STATE':
      return { status: 400, message: `"${error.state}" is not a valid state for a ${error.type}` };
    case 'SPRINT_NOT_FOUND':
      return { status: 404, message: 'Sprint not found' };
    case 'MEMBER_NOT_FOUND':
      return { status: 404, message: 'Team member not found' };
    case 'SELF_PARENT':
      return { status: 400, message: 'A work item cannot be its own parent' };
    case 'PARENT_TYPE_NOT_ALLOWED':
      return { status: 400, message: `A ${error.parentType} cannot be the parent of a ${error.childType}` };
    case 'CIRCULAR_HIERARCHY':
      return { status: 400, message: 'That parent would create a circular hierarchy' };
    case 'ITEM_TAG_LIMIT':
      return { status: 400, message: `Work item ${error.id} would have more than ${error.max} tags` };
    case 'COMMENT_EMPTY':
      return { status: 400, message: 'Comment is empty' };
    case 'COMMENT_NOT_FOUND':
      return { status: 404, message: 'Comment not found' };
    case 'COMMENT_FORBIDDEN':
      return { status: 403, message: "Only the comment's author or an administrator can change it" };
    case 'HYPERLINK_NOT_HTTP':
      return { status: 400, message: 'Only http(s) links are allowed' };
    case 'HYPERLINK_NOT_FOUND':
      return { status: 404, message: 'Hyperlink not found' };
    case 'UNKNOWN_LINK_TYPE':
      return { status: 400, message: `Unknown link type "${error.type}"` };
    case 'LINK_TO_SELF':
      return { status: 400, message: 'A work item cannot link to itself' };
    case 'LINK_DUPLICATE':
      return { status: 400, message: `Work item ${error.targetId} is already linked as ${error.type}` };
    case 'LINK_NOT_FOUND':
      return { status: 404, message: 'Link not found' };
    case 'DELETED_WORK_ITEM_NOT_FOUND':
      return { status: 404, message: `Deleted work item ${error.id} not found` };
    default:
      return assertNever(error);
  }
}
