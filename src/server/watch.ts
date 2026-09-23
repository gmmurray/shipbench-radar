import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';

// Reproduces ../shipbench/apps/cli/src/tui/watch.ts, which the CLI package
// does not export: chokidar over the tasks directory, config.json, and
// layout.json, filtered to `.md` plus those two files, with a 150 ms debounce.

export const DEBOUNCE_MS = 150;

export interface ProjectWatcher {
  close(): Promise<void>;
}

export async function watchProject(
  repoPath: string,
  onChange: () => void,
  debounceMs = DEBOUNCE_MS,
): Promise<ProjectWatcher> {
  const tasksDir = join(repoPath, '.shipbench', 'tasks');
  const configFile = join(repoPath, '.shipbench', 'config.json');
  const layoutFile = join(repoPath, '.shipbench', 'layout.json');

  const watcher: FSWatcher = chokidar.watch(
    [tasksDir, configFile, layoutFile],
    { ignoreInitial: true },
  );

  let debounce: NodeJS.Timeout | undefined;
  watcher.on('all', (_event, changedPath) => {
    if (
      changedPath !== configFile &&
      changedPath !== layoutFile &&
      !changedPath.endsWith('.md')
    ) {
      return;
    }
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(onChange, debounceMs);
  });

  await new Promise<void>((resolve, reject) => {
    watcher.once('ready', resolve);
    watcher.once('error', reject);
  });

  return {
    async close() {
      if (debounce) clearTimeout(debounce);
      await watcher.close();
    },
  };
}
