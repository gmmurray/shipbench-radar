import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/**
 * One registered project. Identity (`id`) and location (`path`) are stored
 * separately so a stale entry can say which project is missing — see
 * DESIGN.md, "The project registry".
 */
export interface RegistryEntry {
  key: string;
  id: string;
  path: string;
}

export interface Registry {
  version: 1;
  projects: RegistryEntry[];
  /** Interface preferences, kept beside the entries rather than inside them. */
  ui: Record<string, unknown>;
}

/** Keys appear in URLs (`/api/projects/:key`, `#/key`), so they stay plain. */
export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export class RegistryError extends Error {
  readonly problems: string[];

  constructor(source: string, problems: string[]) {
    super(
      `Invalid registry at ${source}:\n${problems.map(p => `  - ${p}`).join('\n')}`,
    );
    this.name = 'RegistryError';
    this.problems = problems;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyRegistry(): Registry {
  return { version: 1, projects: [], ui: {} };
}

/**
 * Entries in tab order. `ui.order` lists keys; keys it names come first, in
 * its order, then everything it doesn't mention, in registry order. Read
 * leniently: `ui` is preference, so a malformed or stale order degrades to
 * registry order rather than failing the load.
 */
export function inTabOrder(registry: Registry): RegistryEntry[] {
  const order = registry.ui.order;
  if (!Array.isArray(order)) return registry.projects;

  const byKey = new Map(registry.projects.map(entry => [entry.key, entry]));
  const ordered: RegistryEntry[] = [];
  for (const key of order) {
    const entry = typeof key === 'string' ? byKey.get(key) : undefined;
    if (entry) {
      ordered.push(entry);
      byKey.delete(key as string);
    }
  }
  return [...ordered, ...byKey.values()];
}

/** Parse and validate registry JSON, reporting every problem at once. */
export function parseRegistry(raw: string, source: string): Registry {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new RegistryError(source, [`not valid JSON: ${detail}`]);
  }

  if (!isObject(data)) {
    throw new RegistryError(source, ['the top level must be an object']);
  }

  const problems: string[] = [];

  if (data.version !== 1) {
    problems.push(`"version" must be 1 (got ${JSON.stringify(data.version)})`);
  }

  const ui = data.ui ?? {};
  if (!isObject(ui)) problems.push('"ui" must be an object when present');

  if (!Array.isArray(data.projects)) {
    problems.push('"projects" must be an array');
    throw new RegistryError(source, problems);
  }

  const projects: RegistryEntry[] = [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();

  data.projects.forEach((item: unknown, index: number) => {
    const at = `projects[${index}]`;
    if (!isObject(item)) {
      problems.push(`${at} must be an object`);
      return;
    }

    const { key, id, path } = item;
    let valid = true;

    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      problems.push(
        `${at}.key must be lowercase letters, digits, and hyphens (got ${JSON.stringify(key)})`,
      );
      valid = false;
    } else if (seenKeys.has(key)) {
      problems.push(`${at}.key "${key}" is used by another entry`);
      valid = false;
    }

    if (typeof id !== 'string' || !id.trim()) {
      problems.push(`${at}.id must be a non-empty string`);
      valid = false;
    } else if (seenIds.has(id)) {
      problems.push(`${at}.id "${id}" is used by another entry`);
      valid = false;
    }

    if (typeof path !== 'string' || !isAbsolute(path)) {
      problems.push(
        `${at}.path must be an absolute path (got ${JSON.stringify(path)})`,
      );
      valid = false;
    }

    if (valid) {
      const entry = {
        key: key as string,
        id: id as string,
        path: path as string,
      };
      seenKeys.add(entry.key);
      seenIds.add(entry.id);
      projects.push(entry);
    }
  });

  if (problems.length > 0) throw new RegistryError(source, problems);

  return { version: 1, projects, ui: ui as Record<string, unknown> };
}

/**
 * Load the registry. A missing file is an empty registry, not an error — the
 * first run has nothing registered. A present but invalid file throws, because
 * silently ignoring precious declarations is worse than refusing to start.
 */
export async function loadRegistry(file: string): Promise<Registry> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyRegistry();
    }
    throw error;
  }
  return parseRegistry(raw, file);
}
