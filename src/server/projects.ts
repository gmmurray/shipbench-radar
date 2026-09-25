import { stat } from 'node:fs/promises';
import {
  FsAdapter,
  inspectProjectInitialization,
  type ShipbenchConfig,
} from '@shipbench/core';
import type { RegistryEntry } from './registry.ts';

/**
 * A registry entry and its adapter, whether or not its path currently
 * resolves. Constructing an `FsAdapter` touches nothing on disk, and checking
 * availability per request (below) means a repository that is moved back, or
 * initialized later, becomes available without a restart.
 */
export interface Project {
  entry: RegistryEntry;
  adapter: FsAdapter;
}

export function openProject(entry: RegistryEntry): Project {
  return { entry, adapter: new FsAdapter(entry.path) };
}

export type ProjectStatus =
  | { available: true; config: ShipbenchConfig }
  | { available: false; reason: string };

async function pathProblem(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.isDirectory() ? null : `Not a directory: ${path}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return `Path not found: ${path}`;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return `Cannot read ${path}: ${detail}`;
  }
}

/** Whether the project can be served right now, and why not if it can't. */
export async function inspectProject(project: Project): Promise<ProjectStatus> {
  const problem = await pathProblem(project.entry.path);
  if (problem) return { available: false, reason: problem };

  try {
    const state = await inspectProjectInitialization(project.adapter);
    switch (state.kind) {
      case 'initialized':
        return { available: true, config: state.config };
      case 'missing':
        return {
          available: false,
          reason: `No .shipbench/ directory in ${project.entry.path}`,
        };
      case 'incomplete':
        return {
          available: false,
          reason: `Incomplete .shipbench/: missing ${state.paths.join(', ')}`,
        };
      case 'malformed':
      case 'invalid':
        return {
          available: false,
          reason: `Invalid .shipbench/config.json: ${state.errors.join('; ')}`,
        };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { available: false, reason: detail };
  }
}
