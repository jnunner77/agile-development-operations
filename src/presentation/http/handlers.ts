import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppError } from '#application/errors.ts';
import type { Committed } from '#application/ports.ts';
import { assertNever, err, ok, type Result } from '#shared/result.ts';
import { readJsonBody, type BodyError } from './body.ts';
import { httpFailure } from './errors.ts';
import type { Parsed } from './parse.ts';
import { sendError, sendJson } from './respond.ts';

// Steps shared by every route: read and parse the body, run the use case, answer.

/** Answer with the error's status and message. */
export function fail(res: ServerResponse, error: AppError): void {
  const failure = httpFailure(error);
  sendError(res, failure.status, failure.message);
}

/** Answer with the value itself, or with the error's status and message. */
export function respond<T, E extends AppError>(res: ServerResponse, result: Result<T, E>, status = 200): void {
  if (result.ok) sendJson(res, status, result.value);
  else fail(res, result.error);
}

/** Answer with `{ delta, result }`, or with the error's status and message. */
export async function reply<T, E extends AppError>(res: ServerResponse, pending: Promise<Result<Committed<T>, E>>, status: number): Promise<void> {
  const result = await pending;
  if (result.ok) {
    sendJson(res, status, { delta: result.value.delta, result: result.value.result });
    return;
  }
  fail(res, result.error);
}

function bodyFailure(res: ServerResponse, error: BodyError): void {
  switch (error.code) {
    case 'MALFORMED_JSON':
      return sendError(res, 400, 'Malformed JSON');
    case 'BODY_TOO_LARGE':
      return sendError(res, 413, 'Request is too large');
    default:
      return assertNever(error);
  }
}

/** Read and parse the body; on failure the error response has already been sent. */
export async function input<T>(req: IncomingMessage, res: ServerResponse, parse: (body: unknown) => Parsed<T>): Promise<Result<T, null>> {
  const body = await readJsonBody(req);
  if (!body.ok) {
    bodyFailure(res, body.error);
    return err(null);
  }
  const parsed = parse(body.value);
  if (!parsed.ok) {
    sendError(res, 400, parsed.error.message);
    return err(null);
  }
  return ok(parsed.value);
}

/** A numeric path id; on failure the error response has already been sent. */
export function pathId(res: ServerResponse, raw: string | undefined): Result<number, null> {
  const n = Number(raw);
  if (Number.isInteger(n)) return ok(n);
  sendError(res, 400, 'Invalid id');
  return err(null);
}

/** A query parameter given exactly once and not empty, else null. */
export function queryParam(req: IncomingMessage, name: string): string | null {
  const url = req.url ?? '';
  const queryStart = url.indexOf('?');
  const values = new URLSearchParams(queryStart < 0 ? '' : url.slice(queryStart + 1)).getAll(name);
  return values.length === 1 && values[0] ? values[0] : null;
}
