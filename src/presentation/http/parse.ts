import { err, ok, type Result } from '#shared/result.ts';

// Small hand-written readers that turn untrusted JSON into typed input, one field at a time.

export type ParseError = { readonly code: 'INVALID_REQUEST'; readonly message: string };
export type Parsed<T> = Result<T, ParseError>;
export type Body = Readonly<Record<string, unknown>>;

export const invalid = (message: string): Result<never, ParseError> => err({ code: 'INVALID_REQUEST', message });

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The body must be an object; with `allowed`, any other key is refused. */
export function object(value: unknown, allowed?: readonly string[], where = ''): Parsed<Body> {
  if (!isRecord(value)) return invalid(`${where ? `${where}: ` : ''}Expected a JSON object`);
  if (allowed) {
    const unknown = Object.keys(value).find((k) => !allowed.includes(k));
    if (unknown !== undefined) return invalid(`Unrecognized field "${where ? `${where}.` : ''}${unknown}"`);
  }
  return ok(value);
}

export type Reader<T> = (value: unknown, key: string) => Parsed<T>;

const typeError = (key: string, expected: string) => invalid(`${key}: Expected ${expected}`);

export const string: Reader<string> = (v, key) => (typeof v === 'string' ? ok(v) : typeError(key, 'text'));
export const boolean: Reader<boolean> = (v, key) => (typeof v === 'boolean' ? ok(v) : typeError(key, 'true or false'));
export const number: Reader<number> = (v, key) => (typeof v === 'number' && Number.isFinite(v) ? ok(v) : typeError(key, 'a number'));
export const integer: Reader<number> = (v, key) => (typeof v === 'number' && Number.isInteger(v) ? ok(v) : typeError(key, 'a whole number'));

export function nullable<T>(read: Reader<T>): Reader<T | null> {
  return (v, key) => (v === null ? ok(null) : read(v, key));
}

export function arrayOf<T>(read: Reader<T>, limits: { min?: number; max?: number } = {}): Reader<T[]> {
  return (v, key) => {
    if (!Array.isArray(v)) return typeError(key, 'a list');
    if (limits.min !== undefined && v.length < limits.min) return invalid(`${key}: Expected at least ${limits.min} item${limits.min === 1 ? '' : 's'}`);
    if (limits.max !== undefined && v.length > limits.max) return invalid(`${key}: Expected at most ${limits.max} items`);
    const out: T[] = [];
    for (const [i, item] of v.entries()) {
      const r = read(item, `${key}.${i}`);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return ok(out);
  };
}

export function oneOf<const T extends string>(values: readonly T[]): Reader<T> {
  const isOneOf = (v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);
  return (v, key) => (isOneOf(v) ? ok(v) : typeError(key, `one of ${values.join(', ')}`));
}

/** Read a required field. */
export function required<T>(body: Body, key: string, read: Reader<T>): Parsed<T> {
  return key in body ? read(body[key], key) : invalid(`${key}: Required`);
}

/** Read an optional field: `undefined` when absent. */
export function optional<T>(body: Body, key: string, read: Reader<T>): Parsed<T | undefined> {
  const value = body[key];
  return value === undefined ? ok(undefined) : read(value, key);
}
