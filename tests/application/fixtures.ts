import assert from 'node:assert/strict';
import type { Caller } from '#application/caller.ts';
import type { AppDeps } from '#application/deps.ts';
import { CreateWorkItem } from '#application/work-items/create-work-item.ts';
import type { DomainEvent } from '#domain/events.ts';
import type { WorkItem } from '#domain/types.ts';
import { MemoryLinkRepository } from '#infrastructure/memory/link-repository.ts';
import { MemoryMemberRepository } from '#infrastructure/memory/member-repository.ts';
import { MemoryAccountRepository, MemoryApiTokenRepository, MemorySignInSettingsRepository } from '#infrastructure/memory/sign-in.ts';
import { MemoryFailedAttemptsRepository, MemorySessionRepository } from '#infrastructure/sign-in/memory-sessions.ts';
import { MemorySettingsRepository } from '#infrastructure/memory/settings-repository.ts';
import { MemoryCapacityRepository, MemorySprintRepository } from '#infrastructure/memory/sprint-repository.ts';
import type { Member, Sprint } from '#domain/types.ts';
import { MemoryRecycleBinRepository } from '#infrastructure/memory/recycle-bin-repository.ts';
import { MemoryUnitOfWork } from '#infrastructure/memory/unit-of-work.ts';
import { SerialQueue } from '#infrastructure/serial-writes.ts';
import { MemoryWorkItemRepository } from '#infrastructure/memory/work-item-repository.ts';
import { MemoryGitHubIntegrationRepository } from '#infrastructure/memory/github-integration-repository.ts';
import { MemoryDeliveryLog } from '#infrastructure/github/delivery-log.ts';
import { MemoryProject, MemorySnapshotRepository } from '#infrastructure/memory/backups.ts';
import { MemoryChangeFeed } from '#infrastructure/memory/change-feed.ts';
import { emptyDatabase } from '#infrastructure/json-store/schema.ts';
import type { DevelopmentEvent } from '#domain/dev-links/activity.ts';
import { err, ok } from '#shared/result.ts';
import type { Result } from '#shared/result.ts';

export const NOW = new Date('2026-03-02T10:00:00.000Z');

export const ann: Caller = { name: 'Ann', memberId: 'm1', mayModerateComments: false, admin: 'granted', origin: 'tab-1' };
export const bo: Caller = { name: 'Bo', memberId: 'm2', mayModerateComments: false, admin: 'not-admin', origin: undefined };
export const admin: Caller = { name: 'Admin', memberId: 'm3', mayModerateComments: true, admin: 'granted', origin: undefined };
export const tokenCaller: Caller = { name: 'Bot', memberId: 'm1', mayModerateComments: false, admin: 'token', origin: undefined };

const member = (id: string, name: string): Member => ({ id, name, username: '', email: '', color: '#0078d4', active: true });
const sprint = (id: string, name: string, startDate: string | null = null, finishDate: string | null = null): Sprint => ({ id, name, startDate, finishDate, goal: '' });

export function setup() {
  const items = new MemoryWorkItemRepository();
  const links = new MemoryLinkRepository();
  const recycleBin = new MemoryRecycleBinRepository();
  const sprints = new MemorySprintRepository([sprint('s1', 'Sprint 1', '2026-01-05', '2026-01-16'), sprint('s2', 'Sprint 2', '2026-01-19', '2026-01-30')]);
  const capacities = new MemoryCapacityRepository();
  const members = new MemoryMemberRepository([member('m1', 'Ann'), member('m2', 'Bo'), member('m3', 'Admin')]);
  const settings = new MemorySettingsRepository();
  const unitOfWork = new MemoryUnitOfWork([items, links, recycleBin, sprints, capacities, members, settings]);
  const accounts = new MemoryAccountRepository();
  const signInSettings = new MemorySignInSettingsRepository();
  const apiTokens = new MemoryApiTokenRepository();
  const failedAttempts = new MemoryFailedAttemptsRepository();
  const github = new MemoryGitHubIntegrationRepository();
  const snapshots = new MemorySnapshotRepository();
  const changes = new MemoryChangeFeed();
  /** The whole project, for snapshots and backups; its demo has one member, Dee. */
  const project = new MemoryProject(emptyDatabase({ projectName: 'Fabrikam' }), () => ({
    ...emptyDatabase({ projectName: 'Demo' }),
    members: [member('d1', 'Dee')],
  }));
  /** Development events by the body that stands for them. */
  const payloads = new Map<string, DevelopmentEvent>();
  /** Moves sign-in's clock; tests step it to expire sessions, lockouts and passwords. */
  const clock = { at: NOW.getTime() };
  let secret = 0;
  const published: DomainEvent[] = [];
  let n = 0;
  const deps: AppDeps = {
    items,
    links,
    recycleBin,
    sprints,
    capacities,
    members,
    settings,
    accounts,
    signInSettings,
    sessions: new MemorySessionRepository(),
    failedAttempts,
    apiTokens,
    team: { all: async () => members.rows(), findById: async (id) => members.rows().find((m) => m.id === id) },
    // A stand-in for scrypt: reversible, and fine for tests only.
    hasher: {
      hash: async (password) => `hashed:${password}`,
      verify: async (password, stored) => stored === `hashed:${password}`,
      verifyNothing: async () => undefined,
    },
    secrets: {
      newSessionToken: () => `session-${++secret}`,
      newApiToken: () => `boards_secret${++secret}`,
      digest: (s) => `digest:${s}`,
    },
    signInWrites: new SerialQueue(),
    signInForcedOff: false,
    snapshots,
    project,
    changes,
    github,
    deliveries: new MemoryDeliveryLog(),
    // Stand-ins: a delivery is "signed" with `signed:<secret>`, and its body names a sent event.
    webhookSignatures: { newSecret: () => `webhook-${++secret}`, matches: (secret, _body, signature) => signature === `signed:${secret}` },
    githubPayloads: {
      read: (_event, body) => {
        const sent = payloads.get(new TextDecoder().decode(body));
        return sent ? ok(sent) : err({ code: 'PAYLOAD_NOT_JSON' });
      },
    },
    integrationWrites: new SerialQueue(),
    clock: { now: () => new Date(clock.at) },
    ids: { next: () => `id-${++n}` },
    events: {
      publish: async (events) => {
        published.push(...events);
      },
    },
    unitOfWork,
  };
  const item = (id: number): WorkItem => {
    const row = items.rows().find((w) => w.id === id);
    assert.ok(row, `work item ${id} exists`);
    return row;
  };
  const create = async (type: string, fields: Record<string, unknown> = {}, caller: Caller = ann): Promise<WorkItem> => {
    const result = await new CreateWorkItem(deps).execute({ caller, type, fields: { title: `${type} item`, ...fields } });
    assert.ok(result.ok, JSON.stringify(result));
    return result.value.result;
  };
  return { deps, snapshots, project, changes, github, payloads, items, links, recycleBin, sprints, capacities, members, settings, accounts, signInSettings, apiTokens, failedAttempts, clock, unitOfWork, published, item, create };
}

export function unwrap<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
}
