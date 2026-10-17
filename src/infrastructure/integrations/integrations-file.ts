import path from 'node:path';
import { GitHubIntegration, type GitHubIntegrationData } from '#domain/integrations/github.ts';
import type { GitHubIntegrationRepository } from '#domain/integrations/repository.ts';
import { readJsonFile, writeSecretFile } from '../files.ts';

/** integrations.json: one entry per integration. */
interface IntegrationsFileData {
  github: Partial<GitHubIntegrationData>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Refuse to start on a damaged file rather than guess: "enabled": "false" must never mean on. */
function corrupt(what: string): never {
  throw new Error(`integrations.json is damaged (${what}). Fix or restore it before starting the server.`);
}

function readGitHub(raw: unknown): Partial<GitHubIntegrationData> {
  if (raw === undefined) return {};
  if (!isRecord(raw)) return corrupt('github');
  const out: Partial<GitHubIntegrationData> = {};
  for (const key of ['enabled', 'moveOnPullRequestOpened', 'completeOnMerge'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return corrupt(`github.${key}`);
    out[key] = value;
  }
  const { repositories, secret } = raw;
  if (repositories !== undefined) {
    if (!Array.isArray(repositories) || !repositories.every((r): r is string => typeof r === 'string')) return corrupt('github.repositories');
    out.repositories = repositories;
  }
  if (secret !== undefined) {
    if (secret !== null && typeof secret !== 'string') return corrupt('github.secret');
    out.secret = secret;
  }
  return out;
}

/**
 * Integration settings and webhook secrets, in integrations.json in the data directory. It holds
 * secrets, so it is kept apart from db.json, written readable by the server only, and never
 * reaches browsers, snapshots or exports. Loaded once and kept in memory; every change is written
 * straight through.
 */
export class IntegrationsFile {
  readonly #file: string;
  #data: IntegrationsFileData;

  constructor(dataDir: string) {
    this.#file = path.join(dataDir, 'integrations.json');
    const raw = readJsonFile(this.#file);
    if (raw !== undefined && !isRecord(raw)) corrupt('not an object');
    this.#data = { github: readGitHub(isRecord(raw) ? raw['github'] : undefined) };
  }

  get github(): Partial<GitHubIntegrationData> {
    return { ...this.#data.github };
  }

  saveGitHub(github: GitHubIntegrationData): void {
    const next = { ...this.#data, github: { ...github } };
    // On disk first, so a failed write changes nothing.
    writeSecretFile(this.#file, next);
    this.#data = next;
  }
}

export class FileGitHubIntegrationRepository implements GitHubIntegrationRepository {
  readonly #file: IntegrationsFile;

  constructor(file: IntegrationsFile) {
    this.#file = file;
  }

  async get(): Promise<GitHubIntegration> {
    return GitHubIntegration.reconstitute(this.#file.github);
  }

  async save(integration: GitHubIntegration): Promise<void> {
    this.#file.saveGitHub(integration.toSnapshot());
  }
}
