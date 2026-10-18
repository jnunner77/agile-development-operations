// The few vitest-style matchers the app suites use, on top of node:assert. Kept so the suites'
// assertions read as they did when they ran on vitest.

import { AssertionError } from 'node:assert';
import { inspect } from 'node:util';

const show = (value: unknown) => inspect(value, { depth: 6, breakLength: 120 });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Deep equality as vitest's toEqual: properties set to undefined count as missing. */
export function equals(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return String(a) === String(b);
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equals(v, b[i]));
  }
  if (a instanceof Map && b instanceof Map) return a.size === b.size && [...a].every(([k, v]) => b.has(k) && equals(v, b.get(k)));
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((v) => b.has(v));
  if (!isObject(a) || !isObject(b)) return false;
  const keys = (o: Record<string, unknown>) => Object.keys(o).filter((k) => o[k] !== undefined);
  const ka = keys(a);
  const kb = keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && equals(a[k], b[k]));
}

/** Whether `actual` has everything `expected` has, as vitest's toMatchObject. */
function matchesObject(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => matchesObject(actual[i], v));
  }
  if (isObject(expected) && !(expected instanceof Date) && !(expected instanceof RegExp)) {
    return isObject(actual) && Object.keys(expected).every((k) => k in actual && matchesObject(actual[k], expected[k]));
  }
  return equals(actual, expected);
}

/** A node:test mock function (mock.fn or mock.method). */
interface MockFunction {
  readonly mock: { callCount(): number };
}
/** node:test mocks are proxies: `mock` is there to read, though `'mock' in fn` says otherwise. */
const isMock = (value: unknown): value is MockFunction => {
  if (typeof value !== 'function') return false;
  const context: unknown = Reflect.get(value, 'mock');
  return isObject(context) && typeof Reflect.get(context, 'callCount') === 'function';
};

const lengthOf = (value: unknown): number | undefined => {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (isObject(value) && typeof value['length'] === 'number') return value['length'];
  return undefined;
};

export interface Matchers {
  readonly not: Matchers;
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toHaveLength(length: number): void;
  toMatch(pattern: RegExp | string): void;
  toContain(item: unknown): void;
  toHaveProperty(key: string): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeGreaterThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toThrow(pattern?: RegExp | string): void;
  toHaveBeenCalled(): void;
  toHaveBeenCalledTimes(times: number): void;
}

function matchers(actual: unknown, message: string | undefined, negated: boolean): Matchers {
  const check = (pass: boolean, describe: string, expected?: unknown) => {
    if (pass === negated) {
      const prefix = message ? `${message}: ` : '';
      throw new AssertionError({ message: `${prefix}expected ${show(actual)} ${negated ? 'not ' : ''}${describe}`, actual, expected, operator: describe });
    }
  };
  const callCount = () => {
    if (!isMock(actual)) throw new TypeError(`${show(actual)} is not a mock function`);
    return actual.mock.callCount();
  };
  return {
    get not() {
      return matchers(actual, message, !negated);
    },
    toBe: (expected) => check(Object.is(actual, expected), `to be ${show(expected)}`, expected),
    toEqual: (expected) => check(equals(actual, expected), `to equal ${show(expected)}`, expected),
    toMatchObject: (expected) => check(matchesObject(actual, expected), `to match ${show(expected)}`, expected),
    toHaveLength: (length) => check(lengthOf(actual) === length, `to have length ${length}`, length),
    toMatch: (pattern) => check(typeof actual === 'string' && (typeof pattern === 'string' ? actual.includes(pattern) : pattern.test(actual)), `to match ${String(pattern)}`, pattern),
    toContain: (item) =>
      check((typeof actual === 'string' && typeof item === 'string' && actual.includes(item)) || (Array.isArray(actual) && actual.includes(item)), `to contain ${show(item)}`, item),
    toHaveProperty: (key) => check(isObject(actual) && key in actual, `to have property ${key}`),
    toBeNull: () => check(actual === null, 'to be null'),
    toBeUndefined: () => check(actual === undefined, 'to be undefined'),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeTruthy: () => check(Boolean(actual), 'to be truthy'),
    toBeFalsy: () => check(!actual, 'to be falsy'),
    toBeGreaterThan: (n) => check(typeof actual === 'number' && actual > n, `to be greater than ${n}`),
    toBeLessThanOrEqual: (n) => check(typeof actual === 'number' && actual <= n, `to be at most ${n}`),
    toThrow: (pattern) => {
      if (typeof actual !== 'function') throw new TypeError('toThrow needs a function');
      let thrown: unknown;
      let threw = false;
      try {
        actual();
      } catch (error) {
        threw = true;
        thrown = error;
      }
      const text = thrown instanceof Error ? thrown.message : String(thrown);
      const fits = pattern === undefined || (typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text));
      check(threw && fits, `to throw${pattern === undefined ? '' : ` ${String(pattern)}`}${threw ? ` (threw ${show(text)})` : ''}`);
    },
    toHaveBeenCalled: () => check(callCount() > 0, 'to have been called'),
    toHaveBeenCalledTimes: (times) => check(callCount() === times, `to have been called ${times} times`),
  };
}

/** `expect(value).toBe(…)`; an optional message names what is being checked. */
export function expect(actual: unknown, message?: string): Matchers {
  return matchers(actual, message, false);
}
