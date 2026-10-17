import crypto from 'node:crypto';
import type { WebhookSignatures } from '#application/integrations/ports.ts';

/** 256-bit secrets. GitHub signs each delivery with `sha256=<hex HMAC-SHA256 of the body>`, keyed by the webhook secret. */
export class HmacSignatures implements WebhookSignatures {
  newSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  matches(secret: string, body: Uint8Array, signature: string): boolean {
    if (!secret || !signature.startsWith('sha256=')) return false;
    const expected = crypto.createHmac('sha256', secret).update(body).digest();
    const given = Buffer.from(signature.slice('sha256='.length), 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }
}
