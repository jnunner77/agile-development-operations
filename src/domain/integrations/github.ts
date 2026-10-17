import { err, ok, type Result } from '#shared/result.ts';

/** How the GitHub integration behaves. Shared with the settings page. */
export interface GitHubSettings {
  enabled: boolean;
  /** Move PBIs, bugs and tasks to their "in progress" state when a pull request opens. */
  moveOnPullRequestOpened: boolean;
  /** Move PBIs, bugs and tasks to Done when a pull request merges into the default branch. */
  completeOnMerge: boolean;
  /** Only accept events from these repositories (owner/name); empty = any. */
  repositories: string[];
}

export const DEFAULT_GITHUB_SETTINGS: Readonly<GitHubSettings> = Object.freeze({
  enabled: true,
  moveOnPullRequestOpened: true,
  completeOnMerge: true,
  repositories: [],
});

export const MAX_REPOSITORIES = 50;
export const REPOSITORY_NAME_MAX = 200;
const REPOSITORY_NAME = /^[\w.-]+\/[\w.-]+$/;

/** The settings and the webhook secret, as stored. */
export interface GitHubIntegrationData extends GitHubSettings {
  /** Shared with GitHub to sign deliveries; null until one is created. */
  secret: string | null;
}

export type GitHubSettingsError =
  | { readonly code: 'REPOSITORY_INVALID'; readonly value: string }
  | { readonly code: 'REPOSITORY_NAME_TOO_LONG'; readonly max: number }
  | { readonly code: 'TOO_MANY_REPOSITORIES'; readonly max: number };

export type GitHubIntegrationEvent =
  | { readonly type: 'GitHubSettingsChanged'; readonly occurredAt: Date }
  | { readonly type: 'WebhookSecretRotated'; readonly occurredAt: Date };

export interface GitHubSettingsInput {
  readonly enabled?: boolean | undefined;
  readonly moveOnPullRequestOpened?: boolean | undefined;
  readonly completeOnMerge?: boolean | undefined;
  readonly repositories?: readonly string[] | undefined;
}

type Values = { -readonly [K in keyof GitHubSettings]?: GitHubSettings[K] };

/** A validated change to the settings. Repository names are trimmed and must look like owner/name. */
export class GitHubSettingsChanges {
  readonly #values: Readonly<Values>;

  private constructor(values: Values) {
    this.#values = Object.freeze(values);
    Object.freeze(this);
  }

  static validate(input: GitHubSettingsInput): Result<GitHubSettingsChanges, GitHubSettingsError> {
    const out: Values = {};
    if (input.enabled !== undefined) out.enabled = input.enabled;
    if (input.moveOnPullRequestOpened !== undefined) out.moveOnPullRequestOpened = input.moveOnPullRequestOpened;
    if (input.completeOnMerge !== undefined) out.completeOnMerge = input.completeOnMerge;
    if (input.repositories !== undefined) {
      if (input.repositories.length > MAX_REPOSITORIES) return err({ code: 'TOO_MANY_REPOSITORIES', max: MAX_REPOSITORIES });
      const names: string[] = [];
      for (const raw of input.repositories) {
        const name = raw.trim();
        if (name.length > REPOSITORY_NAME_MAX) return err({ code: 'REPOSITORY_NAME_TOO_LONG', max: REPOSITORY_NAME_MAX });
        if (!REPOSITORY_NAME.test(name)) return err({ code: 'REPOSITORY_INVALID', value: name });
        names.push(name);
      }
      out.repositories = names;
    }
    return ok(new GitHubSettingsChanges(out));
  }

  get values(): Readonly<Values> {
    return this.#values;
  }
}

/** The project's connection to GitHub: what it accepts, and the secret deliveries are signed with. */
export class GitHubIntegration {
  readonly #props: GitHubIntegrationData;
  #events: GitHubIntegrationEvent[] = [];

  private constructor(props: GitHubIntegrationData) {
    this.#props = props;
  }

  /** Stored settings, with defaults for anything missing. */
  static reconstitute(stored: Partial<GitHubIntegrationData> | undefined): GitHubIntegration {
    const props: GitHubIntegrationData = { ...DEFAULT_GITHUB_SETTINGS, secret: null, ...stored };
    return new GitHubIntegration({ ...props, repositories: [...props.repositories] });
  }

  get settings(): GitHubSettings {
    const { secret: _secret, ...settings } = this.#props;
    return { ...settings, repositories: [...settings.repositories] };
  }

  get hasSecret(): boolean {
    return !!this.#props.secret;
  }

  /** The secret deliveries must be signed with, or null while the webhook is off or has no secret. */
  get webhookSecret(): string | null {
    return this.#props.enabled && this.#props.secret ? this.#props.secret : null;
  }

  /** With a list of repositories, only those are accepted (names compare case-insensitively). */
  acceptsRepository(fullName: string): boolean {
    const allowed = this.#props.repositories;
    return !allowed.length || allowed.some((r) => r.toLowerCase() === fullName.toLowerCase());
  }

  get moveOnPullRequestOpened(): boolean {
    return this.#props.moveOnPullRequestOpened;
  }

  get completeOnMerge(): boolean {
    return this.#props.completeOnMerge;
  }

  update(changes: GitHubSettingsChanges, now: Date): void {
    const { repositories, ...flags } = changes.values;
    Object.assign(this.#props, flags);
    if (repositories) this.#props.repositories = [...repositories];
    this.#events.push({ type: 'GitHubSettingsChanged', occurredAt: now });
  }

  /** Replace the secret; the old one stops working at once. */
  rotateSecret(secret: string, now: Date): void {
    if (!secret) throw new Error('A webhook secret cannot be empty');
    this.#props.secret = secret;
    this.#events.push({ type: 'WebhookSecretRotated', occurredAt: now });
  }

  pullEvents(): readonly GitHubIntegrationEvent[] {
    const events = this.#events;
    this.#events = [];
    return events;
  }

  toSnapshot(): GitHubIntegrationData {
    return { ...this.#props, repositories: [...this.#props.repositories] };
  }
}
