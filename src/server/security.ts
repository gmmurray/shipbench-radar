import type { IncomingHttpHeaders } from 'node:http';

// Request checks for a localhost server that can write to every registered
// repository. See DESIGN.md, "The local server". The CLI's board server makes
// none of these checks; Radar does not copy that gap.

export interface RequestCheckOptions {
  /** The port actually bound. */
  port: number;
  /** Extra allowed origins; in dev, Vite's. */
  extraOrigins?: readonly string[];
}

export interface Rejection {
  status: number;
  message: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function allowedOrigins(options: RequestCheckOptions): string[] {
  return [
    ...allowedHosts(options.port).map(host => `http://${host}`),
    ...(options.extraOrigins ?? []),
  ];
}

function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Returns a rejection, or null when the request may proceed.
 *
 * - `Host` must name this server. That defeats DNS rebinding, where a foreign
 *   hostname resolves to 127.0.0.1 and a page reads the API as same-origin.
 * - `Origin`, when present, must be one of ours. Browsers send it on every
 *   cross-origin request and on same-origin writes.
 * - Writes must be `application/json`. A cross-origin page can only send a
 *   JSON content type after a CORS preflight, which Radar never grants, so no
 *   "simple" `text/plain` request can write.
 */
export function checkRequest(
  req: { method?: string; headers: IncomingHttpHeaders },
  options: RequestCheckOptions,
): Rejection | null {
  const host = req.headers.host?.toLowerCase();
  if (!host || !allowedHosts(options.port).includes(host)) {
    return { status: 403, message: 'Forbidden: unexpected Host header.' };
  }

  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins(options).includes(origin)) {
    return { status: 403, message: 'Forbidden: cross-origin request.' };
  }

  const method = req.method ?? 'GET';
  if (
    !SAFE_METHODS.has(method) &&
    mediaType(req.headers['content-type']) !== 'application/json'
  ) {
    return {
      status: 415,
      message: 'Writes must be sent as application/json.',
    };
  }

  return null;
}
