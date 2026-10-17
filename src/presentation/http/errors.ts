import type { AppError } from '#application/errors.ts';
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

const LAST_ADMIN =
  'Sign-in is turned on, so at least one active administrator with a username and a password must remain. Make someone else an administrator first, or turn sign-in off.';

/**
 * The HTTP status and message for every error a use case can return. Adding an error code to the
 * domain or application fails the build here until it has a status.
 */
export function httpFailure(error: AppError): HttpFailure {
  switch (error.code) {
    // Field values
    case 'TITLE_REQUIRED':
      return { status: 400, message: 'Title is required' };
    case 'TEXT_TOO_LONG':
      if (error.field === 'tags') return { status: 400, message: `Tags must be at most ${error.max} characters` };
      if (error.field === 'username') return { status: 400, message: `Username must be ${error.max} characters or fewer` };
      return { status: 400, message: `${label(error.field)} must be at most ${error.max} characters` };
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

    // Work items
    case 'INVALID_WORK_ITEM_ID':
      return { status: 400, message: 'Invalid id' };
    case 'UNKNOWN_WORK_ITEM_TYPE':
      return { status: 400, message: `Unknown work item type "${error.type}"` };
    case 'WORK_ITEM_NOT_FOUND':
      return { status: 404, message: `Work item ${error.id} not found` };
    case 'INVALID_STATE':
      return { status: 400, message: `"${error.state}" is not a valid state for a ${error.type}` };
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

    // Sprints and capacity
    case 'SPRINT_NOT_FOUND':
      return { status: 404, message: 'Sprint not found' };
    case 'SPRINT_NAME_REQUIRED':
      return { status: 400, message: 'Sprint name is required' };
    case 'SPRINT_DATES_INCOMPLETE':
      return { status: 400, message: 'A sprint needs both a start and an end date, or neither' };
    case 'SPRINT_DATES_REVERSED':
      return { status: 400, message: 'Sprint end date must be on or after its start date' };
    case 'SPRINT_NAME_TAKEN':
      return { status: 400, message: `A sprint named "${error.name}" already exists` };
    case 'SPRINT_MOVE_TO_SELF':
      return { status: 400, message: "Choose a different destination for the sprint's work" };
    case 'DAYS_OFF_REVERSED':
      return { status: 400, message: 'Days off end date must be on or after the start date' };
    case 'TOO_MANY_ACTIVITIES':
      return { status: 400, message: `A team member can have at most ${error.max} activities` };
    case 'MEMBER_LISTED_TWICE':
      return { status: 400, message: 'A team member can only appear once in capacity planning' };

    // Team and settings
    case 'MEMBER_NOT_FOUND':
      return { status: 404, message: 'Team member not found' };
    case 'MEMBER_NAME_REQUIRED':
      return { status: 400, message: 'Name is required' };
    case 'USERNAME_INVALID':
      return { status: 400, message: 'Username can only contain letters, numbers, dots, dashes and underscores' };
    case 'USERNAME_TAKEN':
      return { status: 400, message: `Username "${error.username}" is already used by ${error.takenBy}` };
    case 'INVALID_COLOR':
      return { status: 400, message: 'Color must be a hex color like #0078d4' };
    case 'LAST_ADMIN':
      return { status: 400, message: LAST_ADMIN };
    case 'TOO_MANY_WORKING_DAYS':
      return { status: 400, message: `A week has at most ${error.max} working days` };
    case 'SETTING_REQUIRED':
      switch (error.field) {
        case 'workingDays':
          return { status: 400, message: 'Choose at least one working day' };
        case 'areaPaths':
          return { status: 400, message: 'Add at least one area path; area paths cannot be blank' };
        default:
          return { status: 400, message: `${label(error.field)} is required` };
      }
    case 'ADMIN_ONLY':
      return {
        status: 403,
        message: error.reason === 'token' ? "API tokens can't be used to administer the project" : 'Only administrators can do this',
      };
    default:
      return assertNever(error);
  }
}
