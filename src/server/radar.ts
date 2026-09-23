import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRadarHandler } from './app.ts';
import { createEventHub } from './events.ts';
import { openProjects } from './projects.ts';
import type { Registry } from './registry.ts';
import { type ProjectWatcher, watchProject } from './watch.ts';

export const HOST = '127.0.0.1';

export interface StartRadarOptions {
  registry: Registry;
  registryPath: string;
  /** 0 picks a free port (tests). Radar itself uses a fixed one. */
  port: number;
  extraOrigins?: readonly string[];
  webDir: string;
  warn?: (line: string) => void;
}

export interface RunningRadar {
  port: number;
  close(): Promise<void>;
}

/**
 * Everything Radar runs: the HTTP server, one watcher per project, and the
 * shared event stream they feed. `main.ts` adds only process concerns.
 * Rejects (e.g. with EADDRINUSE) if the port can't be bound.
 */
export async function startRadar(
  options: StartRadarOptions,
): Promise<RunningRadar> {
  const projects = openProjects(options.registry);
  const events = createEventHub();

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  const handler = createRadarHandler({
    projects,
    events,
    port,
    extraOrigins: options.extraOrigins,
    webDir: options.webDir,
    registryPath: options.registryPath,
    warn: options.warn,
  });
  server.on('request', (req, res) => void handler(req, res));

  // Watch every project whose directory exists now. A project that is
  // unavailable at startup gets no live updates until Radar restarts; its
  // board still loads once the directory appears.
  const watchers: ProjectWatcher[] = [];
  await Promise.all(
    [...projects.values()].map(async ({ entry }) => {
      if (!existsSync(entry.path)) return;
      try {
        watchers.push(
          await watchProject(entry.path, () => events.broadcast(entry.key)),
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        options.warn?.(
          `Could not watch ${entry.key} (${entry.path}): ${detail}`,
        );
      }
    }),
  );

  return {
    port,
    async close() {
      events.close();
      await Promise.all(watchers.map(watcher => watcher.close()));
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
