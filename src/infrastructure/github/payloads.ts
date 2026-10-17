import type { GitHubPayloads, PayloadError } from '#application/integrations/ports.ts';
import { MAX_COMMITS_PER_PUSH, type DevelopmentActivity, type DevelopmentEvent, type PullRequest, type PushedCommit, type SourceRepository } from '#domain/dev-links/activity.ts';
import { err, ok, type Result } from '#shared/result.ts';

// Translates GitHub's webhook payloads into the development activity the domain understands.
// Only the fields the integration uses are read; anything else in a payload is ignored.

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A required field is missing or has the wrong type. Caught in `read` and returned as an error. */
class Unexpected extends Error {}

function record(parent: Json, key: string, where: string): Json {
  const value = parent[key];
  if (!isRecord(value)) throw new Unexpected(`${where}${key}: Expected an object`);
  return value;
}

function text(parent: Json, key: string, where: string): string {
  const value = parent[key];
  if (typeof value !== 'string') throw new Unexpected(`${where}${key}: Expected text`);
  return value;
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function repository(payload: Json): SourceRepository {
  const repo = record(payload, 'repository', '');
  return {
    fullName: text(repo, 'full_name', 'repository.'),
    htmlUrl: text(repo, 'html_url', 'repository.'),
    defaultBranch: textOrNull(repo['default_branch']) || null,
  };
}

function commits(payload: Json): PushedCommit[] {
  const list = payload['commits'];
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Unexpected('commits: Expected a list');
  // Only the commits that get linked are read.
  return list.slice(0, MAX_COMMITS_PER_PUSH).map((value: unknown, i): PushedCommit => {
    const where = `commits.${i}.`;
    if (!isRecord(value)) throw new Unexpected(`commits.${i}: Expected an object`);
    const author = isRecord(value['author']) ? value['author'] : {};
    return {
      sha: text(value, 'id', where),
      message: text(value, 'message', where),
      url: textOrNull(value['url']) ?? '',
      author: textOrNull(author['username']) ?? textOrNull(author['name']),
      timestamp: textOrNull(value['timestamp']),
    };
  });
}

function pullRequest(payload: Json): PullRequest {
  const pr = record(payload, 'pull_request', '');
  const where = 'pull_request.';
  const number = pr['number'];
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) throw new Unexpected(`${where}number: Expected a whole number`);
  const head = record(pr, 'head', where);
  const base = record(pr, 'base', where);
  const user = isRecord(pr['user']) ? pr['user'] : {};
  return {
    number,
    title: text(pr, 'title', where),
    body: textOrNull(pr['body']),
    url: text(pr, 'html_url', where),
    state: pr['state'] === 'closed' ? 'closed' : 'open',
    merged: pr['merged'] === true || !!textOrNull(pr['merged_at']),
    draft: pr['draft'] === true,
    author: textOrNull(user['login']),
    headRef: text(head, 'ref', `${where}head.`),
    headSha: text(head, 'sha', `${where}head.`),
    baseRef: text(base, 'ref', `${where}base.`),
    createdAt: textOrNull(pr['created_at']),
  };
}

function activity(event: string, payload: Json): DevelopmentActivity {
  switch (event) {
    case 'ping':
      return { kind: 'ping' };
    case 'push':
      return {
        kind: 'push',
        repository: repository(payload),
        ref: textOrNull(payload['ref']) ?? '',
        deleted: payload['deleted'] === true,
        commits: commits(payload),
      };
    case 'create':
    case 'delete': {
      const refType = String(payload['ref_type']);
      if (refType !== 'branch') return { kind: 'otherRef', action: event, refType };
      return { kind: 'branch', action: event, ref: text(payload, 'ref', ''), repository: repository(payload) };
    }
    case 'pull_request':
      return { kind: 'pullRequest', action: String(payload['action']), repository: repository(payload), pullRequest: pullRequest(payload) };
    case 'check_suite': {
      const suite = isRecord(payload['check_suite']) ? payload['check_suite'] : {};
      return { kind: 'checkSuite', headSha: textOrNull(suite['head_sha']) || null, status: String(suite['status']), conclusion: textOrNull(suite['conclusion']) };
    }
    default:
      return { kind: 'other', event };
  }
}

export class GitHubPayloadReader implements GitHubPayloads {
  read(event: string, body: Uint8Array): Result<DevelopmentEvent, PayloadError> {
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
      return err({ code: 'PAYLOAD_NOT_JSON' });
    }
    if (!isRecord(payload)) return err({ code: 'PAYLOAD_INVALID', event, reason: 'Expected a JSON object', repository: '' });
    const repo = isRecord(payload['repository']) ? textOrNull(payload['repository']['full_name']) : null;
    const sender = isRecord(payload['sender']) ? textOrNull(payload['sender']['login']) : null;
    try {
      return ok({ repository: repo ?? '', sender, activity: activity(event, payload) });
    } catch (error) {
      if (error instanceof Unexpected) return err({ code: 'PAYLOAD_INVALID', event, reason: error.message, repository: repo ?? '' });
      throw error;
    }
  }
}
