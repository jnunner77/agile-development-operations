import type { DevelopmentEvent } from '#domain/dev-links/activity.ts';
import type { Result } from '#shared/result.ts';
import type { Delivery } from '../contracts/integrations.ts';

/** Checks GitHub's X-Hub-Signature-256 header: an HMAC-SHA256 of the exact body bytes. */
export interface WebhookSignatures {
  matches(secret: string, body: Uint8Array, signature: string): boolean;
}

export type PayloadError =
  | { readonly code: 'PAYLOAD_NOT_JSON' }
  | { readonly code: 'PAYLOAD_INVALID'; readonly event: string; readonly reason: string };

/** Reads a GitHub delivery's body into the development activity it describes. */
export interface GitHubPayloads {
  read(event: string, body: Uint8Array): Result<DevelopmentEvent, PayloadError>;
}

/** Recent deliveries for the settings page, and which ones have been handled (GitHub retries). */
export interface DeliveryLog {
  record(delivery: Delivery): void;
  recent(): Delivery[];
  wasHandled(id: string): boolean;
  markHandled(id: string): void;
}
