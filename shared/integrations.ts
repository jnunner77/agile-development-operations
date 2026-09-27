/** Types shared by the GitHub integration's server code and its settings page. */

export interface GitHubSettings {
  enabled: boolean;
  /** Move PBIs, bugs and tasks to their "in progress" state when a pull request opens. */
  moveOnPullRequestOpened: boolean;
  /** Move PBIs, bugs and tasks to Done when a pull request merges into the default branch. */
  completeOnMerge: boolean;
  /** Only accept events from these repositories (owner/name); empty = any. */
  repositories: string[];
}

export const DEFAULT_GITHUB_SETTINGS: GitHubSettings = {
  enabled: true,
  moveOnPullRequestOpened: true,
  completeOnMerge: true,
  repositories: [],
};

export interface Delivery {
  id: string;
  event: string;
  repo: string;
  receivedAt: string;
  result: string;
  linked: number[];
  ok: boolean;
}

export interface GitHubAdminView {
  settings: GitHubSettings;
  hasSecret: boolean;
  webhookPath: string;
  deliveries: Delivery[];
}
