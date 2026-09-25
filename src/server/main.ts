import { fileURLToPath } from 'node:url';
import type { ProjectList } from '../shared/types.ts';
import { openBrowser } from './browser.ts';
import { registryPathIn, resolveConfigDir } from './configDir.ts';
import { KEY_HELP, listenForKeys, stopListening } from './console.ts';
import { HOST, startRadar } from './radar.ts';
import { loadRegistry, type Registry, RegistryError } from './registry.ts';

const port = Number(process.env.RADAR_PORT ?? 4747);
const url = `http://${HOST}:${port}/`;
// `pnpm dev:server` passes --dev so the server accepts writes whose Origin is
// the Vite dev server that proxies to it.
const dev = process.argv.includes('--dev');
// The desktop launcher passes --console: single-key commands in the window.
const consoleMode = process.argv.includes('--console');
const webDir = fileURLToPath(new URL('../../dist/web', import.meta.url));

const registryPath = registryPathIn(resolveConfigDir());

if (consoleMode) process.title = 'Radar';

let registry: Registry;
try {
  registry = await loadRegistry(registryPath);
} catch (error) {
  console.error(
    error instanceof RegistryError
      ? error.message
      : `Could not read the registry at ${registryPath}: ${String(error)}`,
  );
  process.exit(1);
}

// Config warnings repeat on every request that loads config; print each once.
const seenWarnings = new Set<string>();
function warn(line: string): void {
  if (seenWarnings.has(line)) return;
  seenWarnings.add(line);
  console.warn(`warning: ${line}`);
}

/** Whether the process holding our port is a Radar (its API answers). */
async function radarAlreadyRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${url}api/projects`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.json()) as Partial<ProjectList>;
    return typeof body.registryPath === 'string';
  } catch {
    return false;
  }
}

function listenAndReport(quit: () => void): void {
  const listening = listenForKeys({
    open: () => {
      openBrowser(url);
      console.log(`Opened ${url} in a new browser tab.`);
    },
    quit,
    help: () => console.log(KEY_HELP),
  });
  if (listening) console.log(`\n${KEY_HELP}\n`);
}

try {
  const radar = await startRadar({
    registry,
    registryPath,
    port,
    extraOrigins: dev ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [],
    webDir,
    warn,
  });

  const count = registry.projects.length;
  console.log(`Radar listening on http://${HOST}:${radar.port}/`);
  console.log(
    `Registry: ${registryPath} (${count} project${count === 1 ? '' : 's'})`,
  );

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    if (consoleMode) {
      stopListening();
      console.log('Stopping Radar...');
    }
    void radar.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (consoleMode) listenAndReport(shutdown);
} catch (error) {
  const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';

  // Double-clicking the launcher while Radar already runs is normal, not an
  // error: offer to open the running one instead.
  if (inUse && consoleMode && (await radarAlreadyRunning())) {
    console.log(`Radar is already running at ${url}`);
    console.log('This window only opens it; closing it leaves Radar running.');
    listenAndReport(() => {
      stopListening();
      process.exit(0);
    });
  } else {
    console.error(
      inUse
        ? `Port ${port} is already in use by something other than Radar. Radar uses a fixed port so pinned tabs keep working; stop the other process or set RADAR_PORT.`
        : `Radar could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
