import type { IncomingMessage, ServerResponse } from 'node:http';

// The single server-sent event stream for every project. One stream, not one
// per project: browsers allow six HTTP/1.1 connections per origin, and each
// open EventSource holds one for good. See DESIGN.md, "Architecture".
//
// Two event types:
// - `tasks-changed`, data `{"project": "<key>"}`: a project's files changed.
// - `registry-changed`, data `{}`: the registry was re-read; re-fetch the
//   project list.

export interface EventHub {
  /** Take over a `GET /api/events` response and keep it open. */
  attach(req: IncomingMessage, res: ServerResponse): void;
  tasksChanged(projectKey: string): void;
  registryChanged(): void;
  close(): void;
}

// A comment line now and then keeps idle connections (and Vite's dev proxy)
// from timing out.
const HEARTBEAT_MS = 25_000;

export function createEventHub(): EventHub {
  const clients = new Set<ServerResponse>();

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref();

  function send(event: string, data: object): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(message);
  }

  return {
    attach(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
    },

    tasksChanged(projectKey) {
      send('tasks-changed', { project: projectKey });
    },

    registryChanged() {
      send('registry-changed', {});
    },

    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}
