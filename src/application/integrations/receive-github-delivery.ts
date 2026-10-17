import {
  MAX_COMMITS_PER_PUSH,
  activityActor,
  branchLink,
  checkResult,
  commitItemIds,
  commitLink,
  finishesWork,
  pullRequestItemIds,
  pullRequestLink,
  pushedBranch,
  startsWork,
  type DevelopmentActivity,
  type DevelopmentEvent,
  type SourceRepository,
} from '#domain/dev-links/activity.ts';
import { branchIds as branchIdsOf } from '#domain/dev-links/references.ts';
import { advancedState } from '#domain/dev-links/automation.ts';
import type { DevLinkDraft } from '#domain/dev-links/dev-link.ts';
import type { GitHubIntegration } from '#domain/integrations/github.ts';
import type { WorkItemError } from '#domain/work-items/errors.ts';
import { FieldChanges } from '#domain/work-items/fields.ts';
import { toWorkItemId } from '#domain/work-items/ids.ts';
import type { WorkItemAggregate } from '#domain/work-items/work-item.ts';
import { assertNever, err, ok, type Result } from '#shared/result.ts';
import type { Caller } from '../caller.ts';
import { runChange, type ChangeSession } from '../session.ts';
import { editItem, save } from '../work-items/helpers.ts';
import type { IntegrationDeps, WebhookError } from './deps.ts';

export interface ReceiveGitHubDeliveryInput {
  /** X-GitHub-Delivery. GitHub reuses it when an administrator redelivers a delivery. */
  readonly deliveryId: string | null;
  /** X-GitHub-Event */
  readonly event: string;
  /** X-Hub-Signature-256 */
  readonly signature: string;
  /** The body exactly as received: the signature covers these bytes. */
  readonly body: Uint8Array;
}

export interface DeliveryOutcome {
  /** What happened, in a few words, as shown on the integrations page. */
  readonly result: string;
  /** Work items the delivery linked or updated. */
  readonly linked: number[];
}

type Outcome = Result<DeliveryOutcome, WorkItemError>;
type Changing = Exclude<DevelopmentActivity, { readonly kind: 'ping' | 'other' | 'otherRef' }>;
type Of<K extends Changing['kind']> = Extract<Changing, { readonly kind: K }>;

const nothing = (result: string): Outcome => ok({ result, linked: [] });

/**
 * A webhook delivery from GitHub. Anything that mentions AB#123, or a branch named like wi/123-…,
 * is linked to work item 123, and pull requests can move items along the board. Everything a
 * delivery changes is one unit of work.
 */
export class ReceiveGitHubDelivery {
  readonly #deps: IntegrationDeps;

  constructor(deps: IntegrationDeps) {
    this.#deps = deps;
  }

  async execute(input: ReceiveGitHubDeliveryInput): Promise<Result<DeliveryOutcome, WebhookError | WorkItemError>> {
    const deps = this.#deps;
    const integration = await deps.github.get();
    const secret = integration.webhookSecret;
    if (secret === null) return err({ code: 'WEBHOOK_CLOSED' });
    if (!deps.webhookSignatures.matches(secret, input.body, input.signature)) return err({ code: 'INVALID_SIGNATURE' });
    const id = input.deliveryId ?? deps.ids.next();
    if (deps.deliveries.wasHandled(id)) return nothing('Duplicate delivery ignored');
    const read = deps.githubPayloads.read(input.event, input.body);
    if (!read.ok) return read;

    const record = (succeeded: boolean, result: string, linked: number[]) =>
      deps.deliveries.record({ id, event: input.event, repo: read.value.repository, receivedAt: deps.clock.now().toISOString(), ok: succeeded, result, linked });
    let outcome: Outcome;
    try {
      outcome = await this.#handle(integration, read.value);
    } catch (error) {
      record(false, `Failed: ${error instanceof Error ? error.message : String(error)}`, []);
      throw error;
    }
    if (!outcome.ok) {
      record(false, `Failed: ${outcome.error.code}`, []);
      return outcome;
    }
    record(true, outcome.value.result, outcome.value.linked);
    // Only once it has been handled, so a redelivery of one that failed is tried again.
    deps.deliveries.markHandled(id);
    return outcome;
  }

  async #handle(integration: GitHubIntegration, event: DevelopmentEvent): Promise<Outcome> {
    if (!integration.acceptsRepository(event.repository)) {
      return nothing(`Ignored: ${event.repository || 'unknown repository'} is not in the allowed list`);
    }
    const { activity } = event;
    switch (activity.kind) {
      case 'ping':
        return nothing('Ping received — the webhook is connected');
      case 'other':
        return nothing(`Ignored event "${activity.event}"`);
      case 'otherRef':
        return nothing(`Ignored ${activity.action} of a ${activity.refType}`);
      default: {
        const caller: Caller = { name: activityActor(event.sender), memberId: null, mayModerateComments: false, admin: 'not-admin', origin: undefined };
        const author = event.sender ?? 'unknown';
        const done = await runChange(this.#deps, caller, (session) => this.#apply(session, integration, activity, author));
        return done.ok ? ok(done.value.result) : done;
      }
    }
  }

  #apply(session: ChangeSession, integration: GitHubIntegration, activity: Changing, author: string): Promise<Outcome> {
    switch (activity.kind) {
      case 'push':
        return this.#push(session, activity, author);
      case 'branch':
        return this.#branch(session, activity, author);
      case 'pullRequest':
        return this.#pullRequest(session, integration, activity);
      case 'checkSuite':
        return this.#checkSuite(session, activity);
      default:
        return assertNever(activity);
    }
  }

  async #push(session: ChangeSession, push: Of<'push'>, author: string): Promise<Outcome> {
    const branch = pushedBranch(push.ref);
    if (branch === null) return nothing('Ignored push to a tag');
    const linked = new Set<number>();
    if (!push.deleted) for (const id of await this.#linkBranch(session, push.repository, branch, 'open', author)) linked.add(id);
    // Every commit pushed to a work item's branch (wi/123-…) belongs to that item too.
    const commits = push.commits.slice(0, MAX_COMMITS_PER_PUSH);
    for (const commit of commits) {
      for (const id of commitItemIds(branch, commit)) {
        if (await this.#link(session, id, commitLink(push.repository, commit, session.now.toISOString()))) linked.add(id);
      }
    }
    return ok({ result: `Push to ${branch}: ${commits.length} commit${commits.length === 1 ? '' : 's'}`, linked: [...linked] });
  }

  async #branch(session: ChangeSession, change: Of<'branch'>, author: string): Promise<Outcome> {
    const created = change.action === 'create';
    const linked = await this.#linkBranch(session, change.repository, change.ref, created ? 'open' : 'deleted', author);
    return ok({ result: `Branch ${change.ref} ${created ? 'created' : 'deleted'}`, linked });
  }

  async #pullRequest(session: ChangeSession, integration: GitHubIntegration, change: Of<'pullRequest'>): Promise<Outcome> {
    const { pullRequest: pr, repository, action } = change;
    const draft = pullRequestLink(repository, pr, session.now.toISOString());
    const linked: number[] = [];
    for (const id of pullRequestItemIds(pr)) {
      const item = await this.#link(session, id, draft);
      if (!item) continue;
      linked.push(id);
      if (startsWork(action, pr) && integration.moveOnPullRequestOpened) {
        const moved = await this.#advance(session, item, 'InProgress', `Pull request #${pr.number} opened`);
        if (!moved.ok) return moved;
      }
      if (finishesWork(action, repository, pr) && integration.completeOnMerge) {
        const moved = await this.#advance(session, item, 'Completed', `Pull request #${pr.number} merged`);
        if (!moved.ok) return moved;
      }
    }
    return ok({ result: `Pull request #${pr.number} ${action}`, linked });
  }

  async #checkSuite(session: ChangeSession, suite: Of<'checkSuite'>): Promise<Outcome> {
    const { headSha } = suite;
    if (!headSha) return nothing('Ignored check suite without a commit');
    const checks = checkResult(suite.status, suite.conclusion);
    const linked: number[] = [];
    for (const item of await this.#deps.items.findAll()) {
      if (!item.recordChecks(headSha, checks, session.now)) continue;
      await save(this.#deps, session, item);
      linked.push(item.id);
    }
    return ok({ result: `Checks ${checks} for ${headSha.slice(0, 7)}`, linked });
  }

  async #linkBranch(session: ChangeSession, repository: SourceRepository, branch: string, state: 'open' | 'deleted', author: string): Promise<number[]> {
    const draft = branchLink(repository, branch, state, author, session.now.toISOString());
    const linked: number[] = [];
    for (const id of branchIdsOf(branch)) if (await this.#link(session, id, draft)) linked.push(id);
    return linked;
  }

  /** Link an item, if it exists. Returns it, or null when there is no such item. */
  async #link(session: ChangeSession, rawId: number, draft: DevLinkDraft): Promise<WorkItemAggregate | null> {
    const id = toWorkItemId(rawId);
    if (!id.ok) return null;
    const item = await this.#deps.items.findById(id.value);
    if (!item) return null;
    item.linkDevelopment(draft, session.context());
    await save(this.#deps, session, item);
    return item;
  }

  /** Move an item forward to the first state of a category, never backwards. */
  async #advance(session: ChangeSession, item: WorkItemAggregate, category: 'InProgress' | 'Completed', note: string): Promise<Result<void, WorkItemError>> {
    const state = advancedState(item.type, item.state, category);
    if (state === null) return ok(undefined);
    const changes = FieldChanges.validate({ state });
    if (!changes.ok) return changes;
    return editItem(this.#deps, session, item, changes.value, { cascade: false, note });
  }
}
