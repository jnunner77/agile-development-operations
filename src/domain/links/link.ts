import type { Brand } from '#shared/brand.ts';
import { err, ok, type Result } from '#shared/result.ts';
import { LINK_REVERSE, LINK_TYPES, type LinkType } from '../process.ts';
import type { WorkItemLink } from '../types.ts';
import type { WorkItemId } from '../work-items/ids.ts';

export type LinkId = Brand<string, 'LinkId'>;

export const MAX_LINK_COMMENT_LENGTH = 1000;
const MAX_LINK_ID_LENGTH = 128;

export type LinkError =
  | { readonly code: 'UNKNOWN_LINK_TYPE'; readonly type: string }
  | { readonly code: 'LINK_TO_SELF' }
  | { readonly code: 'LINK_DUPLICATE'; readonly targetId: number; readonly type: LinkType }
  | { readonly code: 'LINK_NOT_FOUND'; readonly id: string }
  | { readonly code: 'TEXT_TOO_LONG'; readonly field: 'comment'; readonly max: number };

export type LinkEvent =
  | {
      readonly type: 'LinkAdded';
      readonly linkId: string;
      readonly sourceId: number;
      readonly targetId: number;
      readonly linkType: LinkType;
      readonly occurredAt: Date;
    }
  | { readonly type: 'LinkRemoved'; readonly linkId: string; readonly occurredAt: Date };

/** A link id that could never have been issued is reported as not found. */
export function toLinkId(raw: string): Result<LinkId, LinkError> {
  if (!raw || raw.length > MAX_LINK_ID_LENGTH) return err({ code: 'LINK_NOT_FOUND', id: raw });
  return ok(raw as LinkId);
}

export function isLinkType(value: string): value is LinkType {
  return (LINK_TYPES as readonly string[]).includes(value);
}

/** How the target sees a link: Predecessor one way is Successor the other. */
export const reverseLinkType = (type: LinkType): LinkType => LINK_REVERSE[type];

/** A requested link between two work items, checked before either item is looked up. */
export class LinkDraft {
  readonly sourceId: WorkItemId;
  readonly targetId: WorkItemId;
  readonly type: LinkType;
  readonly comment: string;

  private constructor(sourceId: WorkItemId, targetId: WorkItemId, type: LinkType, comment: string) {
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.type = type;
    this.comment = comment;
    Object.freeze(this);
  }

  static of(input: {
    readonly sourceId: WorkItemId;
    readonly targetId: WorkItemId;
    readonly type: string;
    readonly comment?: string | undefined;
  }): Result<LinkDraft, LinkError> {
    if (!isLinkType(input.type)) return err({ code: 'UNKNOWN_LINK_TYPE', type: input.type });
    const comment = input.comment ?? '';
    if (comment.length > MAX_LINK_COMMENT_LENGTH) return err({ code: 'TEXT_TOO_LONG', field: 'comment', max: MAX_LINK_COMMENT_LENGTH });
    if (input.sourceId === input.targetId) return err({ code: 'LINK_TO_SELF' });
    return ok(new LinkDraft(input.sourceId, input.targetId, input.type, comment));
  }
}

/**
 * A typed link between two work items, stored once in the direction it was made. Its `type` is
 * how the source sees the target.
 */
export class Link {
  readonly #props: WorkItemLink;
  #events: LinkEvent[] = [];

  private constructor(props: WorkItemLink) {
    this.#props = props;
  }

  /**
   * Make the link, unless the two items are already linked this way: the same type in the same
   * direction, or the reverse type in the other direction.
   */
  static create(
    draft: LinkDraft,
    input: { readonly id: LinkId; readonly existing: readonly Link[]; readonly actor: string; readonly now: Date },
  ): Result<Link, LinkError> {
    const reverse = reverseLinkType(draft.type);
    const duplicate = input.existing.some(
      (l) =>
        (l.sourceId === draft.sourceId && l.targetId === draft.targetId && l.type === draft.type) ||
        (l.sourceId === draft.targetId && l.targetId === draft.sourceId && l.type === reverse),
    );
    if (duplicate) return err({ code: 'LINK_DUPLICATE', targetId: draft.targetId, type: draft.type });
    const link = new Link({
      id: input.id,
      sourceId: draft.sourceId,
      targetId: draft.targetId,
      type: draft.type,
      comment: draft.comment,
      createdBy: input.actor,
      createdAt: input.now.toISOString(),
    });
    link.#events.push({ type: 'LinkAdded', linkId: input.id, sourceId: draft.sourceId, targetId: draft.targetId, linkType: draft.type, occurredAt: input.now });
    return ok(link);
  }

  static reconstitute(snapshot: WorkItemLink): Link {
    if (!isLinkType(snapshot.type)) throw new Error(`Stored link ${snapshot.id} has unknown type "${String(snapshot.type)}"`);
    return new Link({ ...snapshot });
  }

  get id(): LinkId {
    return this.#props.id as LinkId;
  }
  get sourceId(): WorkItemId {
    return this.#props.sourceId as WorkItemId;
  }
  get targetId(): WorkItemId {
    return this.#props.targetId as WorkItemId;
  }
  get type(): LinkType {
    return this.#props.type;
  }

  involves(itemId: number): boolean {
    return this.#props.sourceId === itemId || this.#props.targetId === itemId;
  }

  /** The history notes each end records when the link is added or removed. */
  historyNotes(change: 'added' | 'removed'): readonly { readonly itemId: WorkItemId; readonly note: string }[] {
    const { sourceId, targetId, type } = this;
    if (change === 'removed') {
      return [
        { itemId: sourceId, note: `Removed link to #${targetId}` },
        { itemId: targetId, note: `Removed link to #${sourceId}` },
      ];
    }
    return [
      { itemId: sourceId, note: `Added ${type} link to #${targetId}` },
      { itemId: targetId, note: `Added ${reverseLinkType(type)} link to #${sourceId}` },
    ];
  }

  remove(now: Date): void {
    this.#events.push({ type: 'LinkRemoved', linkId: this.#props.id, occurredAt: now });
  }

  pullEvents(): readonly LinkEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): WorkItemLink {
    return { ...this.#props };
  }
}
