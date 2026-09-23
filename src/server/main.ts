import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRadarHandler } from './app.ts';
import { registryPathIn, resolveConfigDir } from './configDir.ts';
import { openProjects } from './projects.ts';
import { loadRegistry, RegistryError } from './registry.ts';

const HOST = '127.0.0.1';
const port = Number(process.env.RADAR_PORT ?? 4747);
// `pnpm dev:server` passes --dev so the server accepts writes whose Origin is
// the Vite dev server that proxies to it.
const dev = process.argv.includes('--dev');
const webDir = fileURLToPath(new URL('../../dist/web', import.meta.url));

const registryPath = registryPathIn(resolveConfigDir());

let registry: Awaited<ReturnType<typeof loadRegistry>>;
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

const handler = createRadarHandler({
  projects: openProjects(registry),
  port,
  extraOrigins: dev ? ['http://127.0.0.1:5173', 'http://localhost:5173'] : [],
  webDir,
  registryPath,
  warn,
});

const server = createServer((req, res) => void handler(req, res));

server.on('error', error => {
  const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
  console.error(
    inUse
      ? `Port ${port} is already in use. Radar uses a fixed port so pinned tabs keep working; stop the other process or set RADAR_PORT.`
      : `Radar could not listen on ${HOST}:${port}: ${error.message}`,
  );
  process.exit(1);
});

server.listen(port, HOST, () => {
  const count = registry.projects.length;
  console.log(`Radar listening on http://${HOST}:${port}/`);
  console.log(
    `Registry: ${registryPath} (${count} project${count === 1 ? '' : 's'})`,
  );
});
