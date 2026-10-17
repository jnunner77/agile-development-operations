import crypto from 'node:crypto';
import type { PasswordHasher } from '#application/ports.ts';

// Passwords are never stored or recoverable. Each is run through scrypt (slow and memory-hard)
// with its own random salt, and only the result is kept, as scrypt$N$r$p$salt$key.

const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_MEMORY = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, params: { N: number; r: number; p: number; keylen: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password.normalize('NFKC'), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

export class ScryptHasher implements PasswordHasher {
  /** Unknown usernames are checked against this, so they take as long as a wrong password. */
  #dummy: Promise<string> | undefined;

  async hash(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(password, salt, PARAMS);
    return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [alg, n, r, p, salt, key] = stored.split('$');
    if (alg !== 'scrypt' || !salt || !key) return false;
    const expected = Buffer.from(key, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p), keylen: expected.length });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  async verifyNothing(password: string): Promise<void> {
    this.#dummy ??= this.hash(crypto.randomBytes(16).toString('hex'));
    await this.verify(password, await this.#dummy);
  }
}
