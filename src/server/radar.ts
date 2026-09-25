import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import chokidar from 'chokidar';
import { createRadarHandler } from './app.ts';
import { createEventHub } from './events.ts';
import { openProject, type Project } from './projects.ts';
import {
  inTabOrder,
  loadRegistry,
  type Registry,
  type RegistryEntry,
  RegistryError,
} from './registry.ts';
import { DEBOUNCE_MS, type ProjectWatcher, watchProject } from './watch.ts';

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

interface Slot {
  project: Project;
  /** Null when the directory didn't exist, or watching failed. */
  watcher: ProjectWatcher | null;
}

function sameEntry(a: RegistryEntry, b: RegistryEntry): boolean {
  return a.key === b.key && a.id === b.id && a.path === b.path;
}

/**
 * Everything Radar runs: the HTTP server, one watcher per project, the shared
 * event stream they feed, and a watcher on registry.json that reconciles all
 * of it when the registry changes. `main.ts` adds only process concerns.
 * Rejects (e.g. with EADDRINUSE) if the port can't be bound.
 */
export async function startRadar(
  options: StartRadarOptions,
): Promise<RunningRadar> {
  const { registryPath, warn } = options;
  const events = createEventHub();

  // One map, mutated in place on reconcile, so the request handler always
  // sees the current projects. Insertion order is registry (tab) order.
  const projects = new Map<string, Project>();
  const slots = new Map<string, Slot>();
  let current: Registry = options.registry;
  let registryProblem: string | null = null;

  async function startWatcher(slot: Slot): Promise<void> {
    const { entry } = slot.project;
    if (slot.watcher || !existsSync(entry.path)) return;
    try {
      slot.watcher = await watchProject(entry.path, () =>
        events.tasksChanged(entry.key),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warn?.(`Could not watch ${entry.key} (${entry.path}): ${detail}`);
    }
  }

  /**
   * Bring projects and watchers in line with `registry`. Unchanged entries
   * keep their adapter and watcher; removed or changed ones are closed. Any
   * entry still without a watcher gets another try, so a repository that
   * appeared since startup starts sending live updates.
   */
  async function reconcile(registry: Registry): Promise<void> {
    current = registry;
    const next = new Map<string, Slot>();
    for (const entry of inTabOrder(registry)) {
      const current = slots.get(entry.key);
      if (current && sameEntry(current.project.entry, entry)) {
        next.set(entry.key, current);
      } else {
        next.set(entry.key, { project: openProject(entry), watcher: null });
      }
    }

    const retired = [...slots.entries()].filter(
      ([key, slot]) => next.get(key) !== slot,
    );
    await Promise.all(retired.map(([, slot]) => slot.watcher?.close()));

    slots.clear();
    projects.clear();
    for (const [key, slot] of next) {
      slots.set(key, slot);
      projects.set(key, slot.project);
    }

    await Promise.all([...slots.values()].map(startWatcher));
  }

  await reconcile(options.registry);

  // Serialize re-reads so a burst of registry writes can't interleave two
  // reconciles. The watcher calls this after any change to the file; the
  // registry API also calls it right after its own writes, so its response
  // reflects the change. Either way the server learns only by re-reading
  // the file.
  let pending = Promise.resolve();
  function reloadRegistry(): Promise<void> {
    pending = pending.then(async () => {
      try {
        const registry = await loadRegistry(registryPath);
        await reconcile(registry);
        registryProblem = null;
      } catch (error) {
        // Keep serving the last good registry; say why the new one wasn't
        // taken.
        registryProblem =
          error instanceof RegistryError
            ? error.message
            : `Could not read ${registryPath}: ${String(error)}`;
        warn?.(registryProblem);
      }
      events.registryChanged();
    });
    return pending;
  }

  // Watch the directory rather than the file: the file may not exist yet,
  // and registry writes land by rename.
  const registryDir = dirname(registryPath);
  await mkdir(registryDir, { recursive: true });
  const registryWatcher = chokidar.watch(registryDir, {
    depth: 0,
    ignoreInitial: true,
  });
  let registryDebounce: NodeJS.Timeout | undefined;
  registryWatcher.on('all', (_event, changedPath) => {
    if (resolve(changedPath) !== resolve(registryPath)) return;
    if (registryDebounce) clearTimeout(registryDebounce);
    registryDebounce = setTimeout(() => void reloadRegistry(), DEBOUNCE_MS);
  });
  await new Promise<void>((resolveReady, reject) => {
    registryWatcher.once('ready', resolveReady);
    registryWatcher.once('error', reject);
  });

  const server = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(options.port, HOST, () => {
        server.off('error', reject);
        resolveListen();
      });
    });
  } catch (error) {
    await registryWatcher.close();
    await Promise.all([...slots.values()].map(slot => slot.watcher?.close()));
    events.close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;

  const handler = createRadarHandler({
    projects,
    events,
    registry: {
      path: registryPath,
      current: () => current,
      problem: () => registryProblem,
      reload: reloadRegistry,
    },
    port,
    extraOrigins: options.extraOrigins,
    webDir: options.webDir,
    warn,
  });
  server.on('request', (req, res) => void handler(req, res));

  return {
    port,
    async close() {
      if (registryDebounce) clearTimeout(registryDebounce);
      await registryWatcher.close();
      await pending;
      events.close();
      await Promise.all([...slots.values()].map(slot => slot.watcher?.close()));
      server.closeAllConnections();
      await new Promise<void>(resolveClose =>
        server.close(() => resolveClose()),
      );
    },
  };
}
