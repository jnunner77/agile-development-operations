import type { GitHubSettingsInput } from '#domain/integrations/github.ts';
import { ok } from '#shared/result.ts';
import { arrayOf, boolean, object, optional, string, type Parsed } from '../http/parse.ts';

/** Shape and JSON types only; the domain checks repository names. */
export function parseGitHubSettings(value: unknown): Parsed<GitHubSettingsInput> {
  const body = object(value, ['enabled', 'moveOnPullRequestOpened', 'completeOnMerge', 'repositories']);
  if (!body.ok) return body;
  const b = body.value;
  const enabled = optional(b, 'enabled', boolean);
  if (!enabled.ok) return enabled;
  const moveOnPullRequestOpened = optional(b, 'moveOnPullRequestOpened', boolean);
  if (!moveOnPullRequestOpened.ok) return moveOnPullRequestOpened;
  const completeOnMerge = optional(b, 'completeOnMerge', boolean);
  if (!completeOnMerge.ok) return completeOnMerge;
  const repositories = optional(b, 'repositories', arrayOf(string));
  if (!repositories.ok) return repositories;
  return ok({
    enabled: enabled.value,
    moveOnPullRequestOpened: moveOnPullRequestOpened.value,
    completeOnMerge: completeOnMerge.value,
    repositories: repositories.value,
  });
}
