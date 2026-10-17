import crypto from 'node:crypto';
import type { WebhookSignatures } from '#application/integrations/ports.ts';

/** GitHub signs each delivery with `sha256=<hex HMAC-SHA256 of the body>`, keyed by the webhook secret. */
export class HmacSignatures implements WebhookSignatures {
  matches(secret: string, body: Uint8Array, signature: string): boolean {
    if (!secret || !signature.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    const given = Buffer.from(signature.slice('sha256='.length), 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }
}
