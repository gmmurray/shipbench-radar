import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isObject } from './http.ts';
import { parseRegistry, type RegistryEntry } from './registry.ts';

// Writes to registry.json. Edits go through the raw JSON object, so `ui` and
// any field Radar doesn't know yet survive a round trip. Every write is
// validated by the same parser the server loads with, and lands by rename,
// so a running Radar never reads a half-written file.

export type RawRegistry = Record<string, unknown> & {
  projects: Record<string, unknown>[];
  ui: Record<string, unknown>;
};

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
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (!Array.isArray(data.projects)) {
    throw new Error(`Unexpected registry shape in ${file}`);
  }
  if (!isObject(data.ui)) data.ui = {};
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

/**
 * Read, change, validate, and write the registry in one step. `change`
 * mutates the raw object; returning `false` skips the write.
 */
export async function editRegistry(
  file: string,
  change: (data: RawRegistry) => unknown,
): Promise<void> {
  const data = await readRaw(file);
  if (change(data) === false) return;
  await writeRaw(file, data);
}

function findIndex(data: RawRegistry, key: string): number {
  return data.projects.findIndex(item => isObject(item) && item.key === key);
}

export async function addRegistryEntry(
  file: string,
  entry: RegistryEntry,
): Promise<void> {
  await editRegistry(file, data => {
    data.projects.push({ key: entry.key, id: entry.id, path: entry.path });
  });
}

/** Remove the entry with `key`; returns it, or null if there was none. */
export async function removeRegistryEntry(
  file: string,
  key: string,
): Promise<RegistryEntry | null> {
  let removed: RegistryEntry | null = null;
  await editRegistry(file, data => {
    const index = findIndex(data, key);
    if (index === -1) return false;
    removed = data.projects.splice(index, 1)[0] as unknown as RegistryEntry;
    // A saved tab order shouldn't keep naming a project that's gone.
    if (Array.isArray(data.ui.order)) {
      data.ui.order = data.ui.order.filter(item => item !== key);
    }
    return true;
  });
  return removed;
}

/** Point an existing entry at a new path; other fields are untouched. */
export async function setRegistryEntryPath(
  file: string,
  key: string,
  path: string,
): Promise<boolean> {
  let found = false;
  await editRegistry(file, data => {
    const index = findIndex(data, key);
    if (index === -1) return false;
    data.projects[index]!.path = path;
    found = true;
    return true;
  });
  return found;
}

/** Save the tab order as `ui.order`, beside the entries (DESIGN.md). */
export async function setTabOrder(file: string, keys: string[]): Promise<void> {
  await editRegistry(file, data => {
    data.ui.order = keys;
  });
}
