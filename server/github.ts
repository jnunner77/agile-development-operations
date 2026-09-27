import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { branchIds, mentionedIds } from '../shared/devlinks';
import { TYPE_DEFS, stateCategory } from '../shared/process';
import type { DevLink, WorkItem } from '../shared/types';
import { DEFAULT_GITHUB_SETTINGS, type Delivery, type GitHubAdminView, type GitHubSettings } from '../shared/integrations';
import { HttpError, notFound } from './errors';
import type { Store, Tx } from './store';
import { applyPatch } from './workitems';

// GitHub integration: GitHub sends webhook events (pushes, branches, pull requests, CI
// results) to this app. Anything that mentions AB#123, or a branch named like wi/123-…,
// is linked to work item 123, and pull requests can move items along the board.

interface IntegrationsFile {
  github: GitHubSettings & { secret: string | null };
}

export const githubSettingsSchema = z
  .object({
    enabled: z.boolean(),
    moveOnPullRequestOpened: z.boolean(),
    completeOnMerge: z.boolean(),
    repositories: z.array(z.string().trim().regex(/^[\w.-]+\/[\w.-]+$/, 'Repositories must look like owner/name').max(200)).max(50),
  })
  .partial()
  .strict();

export const WEBHOOK_PATH = '/api/integrations/github/webhook';
const MAX_COMMITS_PER_PUSH = 50;
const MAX_LINKS_PER_ITEM = 200;
const RECENT = 50;

// ---- Minimal shapes of the GitHub payloads we use ---------------------------------

interface Repo {
  full_name: string;
  html_url: string;
  default_branch?: string;
}
interface GhUser {
  login: string;
}
interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  user?: GhUser;
  head: { ref: string; sha: string };
  base: { ref: string };
  created_at?: string;
}

export class GitHubIntegration {
  private data: IntegrationsFile;
  private readonly file: string;
  private readonly deliveries: Delivery[] = [];
  private readonly seen = new Set<string>();

  constructor(private readonly store: Store) {
    this.file = path.join(store.dataDir, 'integrations.json');
    this.data = { github: { ...DEFAULT_GITHUB_SETTINGS, secret: null } };
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<IntegrationsFile>;
      this.data = { github: { ...DEFAULT_GITHUB_SETTINGS, secret: null, ...raw.github } };
    }
  }

  private save() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get settings(): GitHubSettings {
    const { secret: _secret, ...settings } = this.data.github;
    return settings;
  }

  adminView(): GitHubAdminView {
    return { settings: this.settings, hasSecret: !!this.data.github.secret, webhookPath: WEBHOOK_PATH, deliveries: [...this.deliveries] };
  }

  updateSettings(patch: z.infer<typeof githubSettingsSchema>) {
    Object.assign(this.data.github, patch);
    this.save();
  }

  /** Create a new webhook secret. It is returned once and only its value is stored. */
  rotateSecret(): string {
    const secret = crypto.randomBytes(32).toString('hex');
    this.data.github.secret = secret;
    this.save();
    return secret;
  }

  /** Verify GitHub's X-Hub-Signature-256 HMAC over the raw request body. */
  verify(body: Buffer, signature: string | undefined): boolean {
    const secret = this.data.github.secret;
    if (!secret || !signature?.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    const given = Buffer.from(signature.slice(7), 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  private record(d: Delivery) {
    this.deliveries.unshift(d);
    this.deliveries.length = Math.min(this.deliveries.length, RECENT);
  }

  /** Handle one verified webhook delivery. Returns a short description of what happened. */
  handle(event: string, deliveryId: string, payload: Record<string, unknown>): { result: string; linked: number[] } {
    const repo = (payload.repository as Repo | undefined)?.full_name ?? '';
    const allowed = this.data.github.repositories;
    if (allowed.length && !allowed.some((r) => r.toLowerCase() === repo.toLowerCase())) {
      return { result: `Ignored: ${repo || 'unknown repository'} is not in the allowed list`, linked: [] };
    }
    let outcome: { result: string; linked: number[] };
    switch (event) {
      case 'ping':
        outcome = { result: 'Ping received — the webhook is connected', linked: [] };
        break;
      case 'push':
        outcome = this.store.transact(actor(payload), undefined, (tx) => this.onPush(tx, payload)).result;
        break;
      case 'create':
      case 'delete':
        outcome = this.store.transact(actor(payload), undefined, (tx) => this.onBranch(tx, event, payload)).result;
        break;
      case 'pull_request':
        outcome = this.store.transact(actor(payload), undefined, (tx) => this.onPullRequest(tx, payload)).result;
        break;
      case 'check_suite':
        outcome = this.store.transact(actor(payload), undefined, (tx) => this.onCheckSuite(tx, payload)).result;
        break;
      default:
        outcome = { result: `Ignored event "${event}"`, linked: [] };
    }
    this.record({ id: deliveryId, event, repo, receivedAt: new Date().toISOString(), ok: true, ...outcome });
    return outcome;
  }

  // ---- Events ----

  private onPush(tx: Tx, p: Record<string, unknown>) {
    const repo = p.repository as Repo;
    const ref = String(p.ref ?? '');
    if (!ref.startsWith('refs/heads/')) return { result: 'Ignored push to a tag', linked: [] };
    const branch = ref.slice('refs/heads/'.length);
    const linked = new Set<number>();
    if (!p.deleted) for (const id of this.linkBranch(tx, repo, branch, 'open', login(p))) linked.add(id);
    // Every commit pushed to a work item's branch (wi/123-…) belongs to that item too.
    const fromBranch = branchIds(branch);
    const commits = ((p.commits as { id: string; message: string; url: string; author?: { name?: string; username?: string }; timestamp?: string }[]) ?? []).slice(
      0,
      MAX_COMMITS_PER_PUSH,
    );
    for (const c of commits) {
      for (const id of new Set([...fromBranch, ...mentionedIds(c.message)])) {
        if (this.upsert(tx, id, {
          kind: 'commit',
          repo: repo.full_name,
          ref: c.id,
          title: c.message.split('\n')[0].slice(0, 200),
          url: c.url,
          state: null,
          author: c.author?.username ?? c.author?.name ?? 'unknown',
          createdAt: c.timestamp ?? tx.now,
        })) linked.add(id);
      }
    }
    return { result: `Push to ${branch}: ${commits.length} commit${commits.length === 1 ? '' : 's'}`, linked: [...linked] };
  }

  private onBranch(tx: Tx, event: 'create' | 'delete', p: Record<string, unknown>) {
    if (p.ref_type !== 'branch') return { result: `Ignored ${event} of a ${String(p.ref_type)}`, linked: [] };
    const branch = String(p.ref);
    const linked = this.linkBranch(tx, p.repository as Repo, branch, event === 'create' ? 'open' : 'deleted', login(p));
    return { result: `Branch ${branch} ${event === 'create' ? 'created' : 'deleted'}`, linked };
  }

  private onPullRequest(tx: Tx, p: Record<string, unknown>) {
    const pr = p.pull_request as PullRequest;
    const repo = p.repository as Repo;
    const action = String(p.action);
    const state: DevLink['state'] = pr.merged || pr.merged_at ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
    const ids = new Set([...mentionedIds(pr.title), ...mentionedIds(pr.body), ...branchIds(pr.head.ref)]);
    const linked: number[] = [];
    for (const id of ids) {
      const item = this.upsert(tx, id, {
        kind: 'pullRequest',
        repo: repo.full_name,
        ref: String(pr.number),
        title: pr.title.slice(0, 300),
        url: pr.html_url,
        state,
        draft: !!pr.draft,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        author: pr.user?.login ?? 'unknown',
        createdAt: pr.created_at ?? tx.now,
      });
      if (!item) continue;
      linked.push(id);
      const opened = ['opened', 'reopened', 'ready_for_review'].includes(action) && state === 'open' && !pr.draft;
      if (opened && this.data.github.moveOnPullRequestOpened) this.advance(tx, item, 'InProgress', `Pull request #${pr.number} opened`);
      const mergedToDefault = action === 'closed' && state === 'merged' && (!repo.default_branch || pr.base.ref === repo.default_branch);
      if (mergedToDefault && this.data.github.completeOnMerge) this.advance(tx, item, 'Completed', `Pull request #${pr.number} merged`);
    }
    return { result: `Pull request #${pr.number} ${action}`, linked };
  }

  private onCheckSuite(tx: Tx, p: Record<string, unknown>) {
    const suite = p.check_suite as { head_sha: string; status: string; conclusion: string | null };
    if (!suite?.head_sha) return { result: 'Ignored check suite without a commit', linked: [] };
    const checks: DevLink['checks'] =
      suite.status !== 'completed' ? 'pending' : suite.conclusion === 'success' || suite.conclusion === 'neutral' || suite.conclusion === 'skipped' ? 'success' : 'failure';
    const linked: number[] = [];
    for (const item of tx.db.workItems) {
      const link = item.devLinks.find((l) => l.kind === 'pullRequest' && l.headSha === suite.head_sha);
      if (!link || link.checks === checks) continue;
      link.checks = checks;
      link.updatedAt = tx.now;
      tx.touchItem(item.id);
      linked.push(item.id);
    }
    return { result: `Checks ${checks} for ${suite.head_sha.slice(0, 7)}`, linked };
  }

  // ---- Helpers ----

  private linkBranch(tx: Tx, repo: Repo, branch: string, state: 'open' | 'deleted', author: string): number[] {
    const linked: number[] = [];
    for (const id of branchIds(branch)) {
      const ok = this.upsert(tx, id, {
        kind: 'branch',
        repo: repo.full_name,
        ref: branch,
        title: branch,
        url: `${repo.html_url}/tree/${encodeURIComponent(branch).replace(/%2F/g, '/')}`,
        state,
        author,
        createdAt: tx.now,
      });
      if (ok) linked.push(id);
    }
    return linked;
  }

  /** Add or update a link on a work item. Returns the item, or null if it doesn't exist. */
  private upsert(tx: Tx, itemId: number, fields: Omit<DevLink, 'id' | 'updatedAt'>): WorkItem | null {
    const item = tx.db.workItems.find((w) => w.id === itemId);
    if (!item) return null;
    const id = `${fields.kind}:${fields.repo.toLowerCase()}:${fields.ref}`;
    const existing = item.devLinks.find((l) => l.id === id);
    if (existing) {
      const before = existing.state;
      Object.assign(existing, { ...fields, createdAt: existing.createdAt, checks: existing.checks ?? null }, { updatedAt: tx.now });
      if (fields.kind === 'pullRequest' && before !== fields.state && fields.state) {
        note(tx, item, `Pull request #${fields.ref} ${fields.state === 'open' ? 'reopened' : fields.state} (${fields.repo})`);
      }
    } else {
      if (item.devLinks.length >= MAX_LINKS_PER_ITEM) {
        // Keep the newest links; old commits go first.
        const oldestCommit = item.devLinks.findIndex((l) => l.kind === 'commit');
        item.devLinks.splice(oldestCommit >= 0 ? oldestCommit : 0, 1);
      }
      item.devLinks.push({ ...fields, id, checks: null, updatedAt: tx.now });
      note(tx, item, `Linked ${describe(fields)} in ${fields.repo}`);
    }
    tx.touchItem(item.id);
    return item;
  }

  /** Move an item forward to the first state of a category, never backwards. */
  private advance(tx: Tx, item: WorkItem, category: 'InProgress' | 'Completed', why: string) {
    if (!['Product Backlog Item', 'Bug', 'Task'].includes(item.type)) return;
    const order = ['Proposed', 'InProgress', 'Completed'];
    const current = stateCategory(item.type, item.state);
    if (current === 'Removed' || order.indexOf(current) >= order.indexOf(category)) return;
    const target = TYPE_DEFS[item.type].states.find((s) => s.category === category);
    if (target) applyPatch(tx, item, { state: target.name }, why);
  }

  removeLink(tx: Tx, itemId: number, linkId: string) {
    const item = tx.item(itemId);
    const link = item.devLinks.find((l) => l.id === linkId);
    if (!link) throw notFound('Link');
    item.devLinks = item.devLinks.filter((l) => l.id !== linkId);
    note(tx, item, `Removed link to ${describe(link)}`);
    tx.touchItem(itemId);
  }

  // ---- Express glue ----

  /** Public webhook endpoint (authenticated by signature, not by session). */
  webhook = (req: Request, res: Response) => {
    if (!this.data.github.enabled || !this.data.github.secret) throw notFound('Webhook');
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!this.verify(body, req.get('x-hub-signature-256'))) throw new HttpError(401, 'Invalid signature');
    const event = req.get('x-github-event') ?? '';
    const deliveryId = req.get('x-github-delivery') ?? randomUUID();
    if (this.seen.has(deliveryId)) return res.status(200).json({ result: 'Duplicate delivery ignored' });
    this.seen.add(deliveryId);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value!);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new HttpError(400, 'Payload must be JSON (set the webhook content type to application/json)');
    }
    try {
      res.json(this.handle(event, deliveryId, payload));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.record({ id: deliveryId, event, repo: (payload.repository as Repo | undefined)?.full_name ?? '', receivedAt: new Date().toISOString(), ok: false, result: `Failed: ${message}`, linked: [] });
      throw err;
    }
  };

  /** Raw body parser for the webhook route (signatures are computed over the exact bytes). */
  static rawBody = express.raw({ type: () => true, limit: '10mb' });
}

function login(p: Record<string, unknown>) {
  return (p.sender as GhUser | undefined)?.login ?? 'unknown';
}

/** Name recorded in work item history for changes made by GitHub events. */
function actor(p: Record<string, unknown>) {
  const who = (p.sender as GhUser | undefined)?.login;
  return who ? `GitHub (${who})` : 'GitHub';
}

function describe(l: Pick<DevLink, 'kind' | 'ref' | 'title'>) {
  if (l.kind === 'pullRequest') return `pull request #${l.ref}`;
  if (l.kind === 'commit') return `commit ${l.ref.slice(0, 7)}`;
  return `branch ${l.ref}`;
}

function note(tx: Tx, item: WorkItem, text: string) {
  item.history.push({ id: randomUUID(), changedBy: tx.user, changedAt: tx.now, changes: [], note: text });
  item.changedAt = tx.now;
  item.changedBy = tx.user;
}
