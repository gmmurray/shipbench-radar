import type { IncomingMessage, ServerResponse } from 'node:http';
import { ArchiveBlockedError } from '@shipbench/core';

// Response and body helpers, mirrored from the CLI's boardServer.ts so the
// board sees the same status codes and error bodies from either host.

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(body));
}

export function sendError(
  res: ServerResponse,
  status: number,
  error: string,
): void {
  sendJson(res, status, { error });
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

export function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/ENOENT/.test(error.message) ||
      /no such file/i.test(error.message) ||
      /not found/i.test(error.message))
  );
}

function isValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^(Invalid|Task (?:title|update text|update index) must|Cannot (?:add|edit|delete) an update|Config must|Duplicate|Default priority|default_column|done_column|Layout key|Request body|"[^"]+" must)/i.test(
      error.message,
    )
  );
}

export function coreErrorStatus(error: unknown): number {
  if (isNotFoundError(error)) return 404;
  if (error instanceof ArchiveBlockedError) return 409;
  if (isValidationError(error)) return 400;
  return 500;
}

export async function readJson(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw.trim()) return {};

  const parsed = JSON.parse(raw) as unknown;
  if (!isObject(parsed)) throw new Error('Request body must be a JSON object.');
  return parsed;
}
