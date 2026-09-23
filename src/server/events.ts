import type { IncomingMessage, ServerResponse } from 'node:http';

// The single server-sent event stream for every project. One stream, not one
// per project: browsers allow six HTTP/1.1 connections per origin, and each
// open EventSource holds one for good. See DESIGN.md, "Architecture".

/** The payload of every `tasks-changed` event. */
export interface TasksChangedEvent {
  project: string;
}

export interface EventHub {
  /** Take over a `GET /api/events` response and keep it open. */
  attach(req: IncomingMessage, res: ServerResponse): void;
  /** Tell every client that a project's files changed. */
  broadcast(projectKey: string): void;
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

    broadcast(projectKey) {
      const payload: TasksChangedEvent = { project: projectKey };
      const message = `event: tasks-changed\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const client of clients) client.write(message);
    },

    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}
