import crypto from 'node:crypto';
import type { Secrets } from '#application/ports.ts';
import { API_TOKEN_PREFIX } from '#domain/api-tokens/api-token.ts';

/**
 * 256-bit random secrets. API tokens are long random strings, so a fast SHA-256 digest is enough
 * to keep in their place (a slow hash only matters for guessable passwords).
 */
export class RandomSecrets implements Secrets {
  newSessionToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  newApiToken(): string {
    return API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  }

  digest(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('hex');
  }
}
