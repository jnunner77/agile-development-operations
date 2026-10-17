import { toLinkId, type LinkError } from '#domain/links/link.ts';
import { err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import type { Committed } from '../ports.ts';
import type { WorkItemDeps } from './deps.ts';
import { save } from './helpers.ts';
import { runChange } from '../session.ts';

export interface RemoveLinkInput {
  readonly caller: Caller;
  readonly linkId: string;
}

export class RemoveLink {
  readonly #deps: WorkItemDeps;

  constructor(deps: WorkItemDeps) {
    this.#deps = deps;
  }

  async execute(input: RemoveLinkInput): Promise<Result<Committed<void>, LinkError>> {
    const id = toLinkId(input.linkId);
    if (!id.ok) return id;
    return runChange(this.#deps, input.caller, async (session) => {
      const link = await this.#deps.links.findById(id.value);
      if (!link) return err({ code: 'LINK_NOT_FOUND', id: input.linkId });
      link.remove(session.now);
      await this.#deps.links.delete(link.id);
      session.record(link);
      for (const { itemId, note } of link.historyNotes('removed')) {
        const item = await this.#deps.items.findById(itemId);
        if (!item) continue;
        item.addNote(note, session.context());
        await save(this.#deps, session, item);
      }
      return ok(undefined);
    });
  }
}
