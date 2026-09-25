import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProjectSuggestion } from '../shared/types.ts';
import {
  directoryName,
  githubIdentity,
  readOriginUrl,
  suggestKey,
} from './identity.ts';
import { inspectProject, openProject } from './projects.ts';
import { KEY_PATTERN, type Registry, type RegistryEntry } from './registry.ts';

// The rules for changing the registry, shared by `pnpm radar` and the
// Projects page so the two can't disagree about what's valid. Nothing here
// writes; callers plan a change, then apply it through registryFile.ts.

export type RegistrationField = 'path' | 'key' | 'id';

/** A change that isn't allowed; the message is meant for the user. */
export class RegistrationError extends Error {
  readonly status: number;
  /** The input to fix, so a form can point at it and the CLI name its flag. */
  readonly field?: RegistrationField;
  /** A value that would work, when there's an obvious one. */
  readonly example?: string;

  constructor(
    message: string,
    options: {
      status?: number;
      field?: RegistrationField;
      example?: string;
    } = {},
  ) {
    super(message);
    this.name = 'RegistrationError';
    this.status = options.status ?? 400;
    this.field = options.field;
    this.example = options.example;
  }
}

export function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
}

function requireAbsolute(path: string): string {
  if (!path.trim() || !isAbsolute(path.trim())) {
    throw new RegistrationError('Use an absolute path to the repository.', {
      field: 'path',
    });
  }
  return resolve(path.trim());
}

async function requireShipbenchProject(path: string): Promise<void> {
  const status = await inspectProject(openProject({ key: '-', id: '-', path }));
  if (!status.available) {
    throw new RegistrationError(
      `${status.reason}\nOnly an initialized ShipBench project can be registered; run "shipbench init" there first.`,
      { field: 'path' },
    );
  }
}

function registeredAt(registry: Registry, path: string, except?: string) {
  return registry.projects.find(
    entry => entry.key !== except && samePath(entry.path, path),
  );
}

export interface AdditionRequest {
  /** Absolute; the CLI resolves relative paths before asking. */
  path: string;
  key?: string;
  id?: string;
}

/** Work out the entry `add` would create, or say why it can't. */
export async function planAddition(
  request: AdditionRequest,
  registry: Registry,
): Promise<RegistryEntry> {
  const path = requireAbsolute(request.path);
  await requireShipbenchProject(path);

  const remote = await readOriginUrl(path);
  const github = remote ? githubIdentity(remote) : null;
  const example = `local/${directoryName(path)}`;

  let id = request.id?.trim();
  if (!id) {
    if (!github) {
      throw new RegistrationError(
        remote
          ? `The origin remote (${remote}) is not a GitHub URL, so this project needs an identity.`
          : `${path} has no origin remote, so this project needs an identity.`,
        { field: 'id', example },
      );
    }
    id = github.id;
  }

  const nameForKey = github?.repo ?? directoryName(path);
  const key = request.key?.trim() || suggestKey(nameForKey);
  if (!key) {
    throw new RegistrationError(`Couldn't derive a key from "${nameForKey}".`, {
      field: 'key',
    });
  }
  if (!KEY_PATTERN.test(key)) {
    throw new RegistrationError(
      `Invalid key "${key}": use lowercase letters, digits, and hyphens.`,
      { field: 'key' },
    );
  }

  for (const existing of registry.projects) {
    if (existing.key === key) {
      throw new RegistrationError(
        `The key "${key}" is already used by ${existing.id} (${existing.path}).`,
        { status: 409, field: 'key' },
      );
    }
    if (existing.id === id) {
      throw new RegistrationError(
        `${id} is already registered as "${existing.key}" (${existing.path}).\nRadar treats every checkout of one repository as one project; change that entry's path to move it.`,
        { status: 409, field: 'id' },
      );
    }
  }
  const clash = registeredAt(registry, path);
  if (clash) {
    throw new RegistrationError(
      `${path} is already registered as "${clash.key}" (${clash.id}).`,
      { status: 409, field: 'path' },
    );
  }

  return { key, id, path };
}

/**
 * Work out the entry after pointing `key` at `newPath`: the repair for a
 * repository that moved. The identity stays; for a GitHub identity the new
 * checkout's origin must match it, so a repair can't quietly swap in a
 * different repository. A declared (`local/…`) identity has nothing to check.
 */
export async function planRepair(
  key: string,
  newPath: string,
  registry: Registry,
): Promise<RegistryEntry> {
  const entry = registry.projects.find(p => p.key === key);
  if (!entry) {
    throw new RegistrationError(`No project "${key}".`, { status: 404 });
  }

  const path = requireAbsolute(newPath);
  await requireShipbenchProject(path);

  if (entry.id.startsWith('github.com/')) {
    const remote = await readOriginUrl(path);
    const found = remote ? githubIdentity(remote)?.id : undefined;
    if (found !== entry.id) {
      throw new RegistrationError(
        found
          ? `That checkout is ${found}, not ${entry.id}.`
          : `That checkout has no GitHub origin, so it can't be confirmed as ${entry.id}.`,
        { status: 409, field: 'path' },
      );
    }
  }

  const clash = registeredAt(registry, path, key);
  if (clash) {
    throw new RegistrationError(
      `${path} is already registered as "${clash.key}".`,
      { status: 409, field: 'path' },
    );
  }

  return { ...entry, path };
}

const MAX_SUGGESTIONS = 50;

/**
 * Unregistered ShipBench projects sitting next to registered ones: the
 * directories beside each registered repository that have a
 * `.shipbench/config.json`. Nothing is registered from here; the Projects
 * page only offers them, and adding one still takes a click (DESIGN.md,
 * "Non-goals").
 */
export async function findSuggestions(
  registry: Registry,
): Promise<ProjectSuggestion[]> {
  const parents: string[] = [];
  for (const entry of registry.projects) {
    const parent = dirname(entry.path);
    if (!parents.some(seen => samePath(seen, parent))) parents.push(parent);
  }

  const found: ProjectSuggestion[] = [];
  for (const parent of parents) {
    let children: string[];
    try {
      children = (await readdir(parent, { withFileTypes: true }))
        .filter(item => item.isDirectory())
        .map(item => item.name);
    } catch {
      continue;
    }
    for (const name of children) {
      const path = join(parent, name);
      if (registeredAt(registry, path)) continue;
      if (found.some(s => samePath(s.path, path))) continue;
      if (!existsSync(join(path, '.shipbench', 'config.json'))) continue;
      found.push({ path, name });
    }
  }

  return found
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS);
}
