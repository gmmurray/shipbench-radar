import { fileURLToPath } from 'node:url';
import { registryPathIn, resolveConfigDir } from './configDir.ts';
import { HOST, startRadar } from './radar.ts';
import { loadRegistry, type Registry, RegistryError } from './registry.ts';

const port = Number(process.env.RADAR_PORT ?? 4747);
// `pnpm dev:server` passes --dev so the server accepts writes whose Origin is
// the Vite dev server that proxies to it.
const dev = process.argv.includes('--dev');
const webDir = fileURLToPath(new URL('../../dist/web', import.meta.url));

const registryPath = registryPathIn(resolveConfigDir());

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

  const shutdown = () => {
    void radar.close().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
  console.error(
    inUse
      ? `Port ${port} is already in use. Radar uses a fixed port so pinned tabs keep working; stop the other process or set RADAR_PORT.`
      : `Radar could not start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
