import { type IncomingHttpHeaders, request } from 'node:http';

// Helpers for tests that talk to a real Radar over HTTP. Not a test file
// itself (Vitest only collects *.test.ts).

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export function send(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: options.headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export const JSON_HEADERS = { 'content-type': 'application/json' };

export function sendJson(
  port: number,
  method: string,
  path: string,
  value?: unknown,
): Promise<Reply> {
  return send(port, method, path, {
    headers: JSON_HEADERS,
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

export interface StreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface EventStream {
  events: StreamEvent[];
  /** Project keys of the `tasks-changed` events received so far. */
  projects(): string[];
  close(): void;
}

/** Open the shared event stream and record every event it delivers. */
export function openEventStream(port: number): Promise<EventStream> {
  return new Promise((resolve, reject) => {
    const events: StreamEvent[] = [];
    const req = request(
      { host: '127.0.0.1', port, path: '/api/events' },
      res => {
        let buffer = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          const messages = buffer.split('\n\n');
          buffer = messages.pop() ?? '';
          for (const message of messages) {
            const event = /^event: (.*)$/m.exec(message)?.[1];
            const data = /^data: (.*)$/m.exec(message)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data) });
          }
        });
        resolve({
          events,
          projects: () =>
            events
              .filter(e => e.event === 'tasks-changed')
              .map(e => e.data.project as string),
          close: () => req.destroy(),
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export const TASK_FILE = `---
title: Written by an agent
status: todo
created: 2026-09-23T00:00:00.000Z
updated: 2026-09-23T00:00:00.000Z
---
`;
