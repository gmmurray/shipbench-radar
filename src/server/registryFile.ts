import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isObject } from './http.ts';
import { parseRegistry, type RegistryEntry } from './registry.ts';

// Writes to registry.json. Edits go through the raw JSON object, so `ui` and
// any field Radar doesn't know yet survive a round trip. Every write is
// validated by the same parser the server loads with, and lands by rename,
// so a running Radar never reads a half-written file.

type RawRegistry = Record<string, unknown> & { projects: unknown[] };

async function readRaw(file: string): Promise<RawRegistry> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, projects: [], ui: {} };
    }
    throw error;
  }
  parseRegistry(raw, file);
  const data = JSON.parse(raw) as unknown;
  if (!isObject(data) || !Array.isArray(data.projects)) {
    throw new Error(`Unexpected registry shape in ${file}`);
  }
  return data as RawRegistry;
}

const RENAME_RETRIES = 5;

async function writeRaw(file: string, data: RawRegistry): Promise<void> {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  parseRegistry(text, file);

  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, 'utf-8');

  // On Windows a reader (the server's watcher, an editor) can briefly hold
  // the target open; retry the replace rather than fail.
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient =
        code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= RENAME_RETRIES) {
        await rm(temp, { force: true });
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 50 * attempt));
    }
  }
}

export async function addRegistryEntry(
  file: string,
  entry: RegistryEntry,
): Promise<void> {
  const data = await readRaw(file);
  data.projects.push({ key: entry.key, id: entry.id, path: entry.path });
  await writeRaw(file, data);
}

/** Remove the entry with `key`; returns it, or null if there was none. */
export async function removeRegistryEntry(
  file: string,
  key: string,
): Promise<RegistryEntry | null> {
  const data = await readRaw(file);
  const index = data.projects.findIndex(
    item => isObject(item) && item.key === key,
  );
  if (index === -1) return null;
  const [removed] = data.projects.splice(index, 1);
  await writeRaw(file, data);
  return removed as RegistryEntry;
}
