import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProjectSuggestion } from '../shared/types.ts';
import { readJson, sendError, sendJson, sendNoContent } from './http.ts';
import {
  findSuggestions,
  planAddition,
  planRepair,
  RegistrationError,
} from './registration.ts';
import { loadRegistry, type Registry, RegistryError } from './registry.ts';
import {
  addRegistryEntry,
  removeRegistryEntry,
  setProjectHidden,
  setRegistryEntryPath,
  setTabOrder,
} from './registryFile.ts';

// The Projects page's API: add, repair, remove, reorder, show/hide, and
// suggestions.
// Rules come from registration.ts, the same ones `pnpm radar` uses. Writes
// go to registry.json through registryFile.ts; the server then re-reads the
// file before responding, so the page's next list is already current.

export interface RegistryControls {
  path: string;
  /** The last good registry the server loaded. */
  current(): Registry;
  /** Why the latest file couldn't be loaded, if it couldn't. */
  problem(): string | null;
  /** Re-read registry.json and reconcile. */
  reload(): Promise<void>;
}

const PROJECT_ROUTE = /^\/projects\/([^/]+)$/;
const HIDDEN_ROUTE = /^\/projects\/([^/]+)\/hidden$/;

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string')
    throw new Error(`"${field}" must be a string.`);
  return value;
}

/**
 * Plan against the file, not the in-memory copy: the file is what the write
 * will change. A broken file blocks writes until it's fixed.
 */
async function loadForWrite(controls: RegistryControls): Promise<Registry> {
  try {
    return await loadRegistry(controls.path);
  } catch (error) {
    if (error instanceof RegistryError) {
      throw new RegistrationError(
        `registry.json has errors; fix it before changing projects here.\n${error.message}`,
        { status: 409 },
      );
    }
    throw error;
  }
}

export async function handleRegistryApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  controls: RegistryControls,
): Promise<void> {
  try {
    await routeRegistryRequest(req, res, route, controls);
  } catch (error) {
    if (error instanceof RegistrationError) {
      sendJson(res, error.status, {
        error: error.message,
        field: error.field,
        example: error.example,
      });
      return;
    }
    throw error;
  }
}

async function routeRegistryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  controls: RegistryControls,
): Promise<void> {
  if (req.method === 'GET' && route === '/suggestions') {
    const suggestions: ProjectSuggestion[] = await findSuggestions(
      controls.current(),
    );
    sendJson(res, 200, { suggestions });
    return;
  }

  // Add, or with `dryRun` just report what would be added.
  if (req.method === 'POST' && route === '/projects') {
    const body = await readJson(req);
    const entry = await planAddition(
      {
        path: optionalString(body.path, 'path') ?? '',
        key: optionalString(body.key, 'key'),
        id: optionalString(body.id, 'id'),
      },
      await loadForWrite(controls),
    );
    if (body.dryRun !== true) {
      await addRegistryEntry(controls.path, entry);
      await controls.reload();
    }
    sendJson(res, 200, { entry });
    return;
  }

  if (req.method === 'PUT' && route === '/order') {
    const body = await readJson(req);
    if (
      !Array.isArray(body.order) ||
      !body.order.every(key => typeof key === 'string')
    ) {
      throw new Error('"order" must be an array of keys.');
    }
    const registry = await loadForWrite(controls);
    const known = new Set(registry.projects.map(p => p.key));
    const order = [...new Set(body.order as string[])].filter(key =>
      known.has(key),
    );
    await setTabOrder(controls.path, order);
    await controls.reload();
    sendNoContent(res);
    return;
  }

  // Show or hide a project's tab. It stays registered either way.
  const hiddenMatch = HIDDEN_ROUTE.exec(route);
  if (req.method === 'PUT' && hiddenMatch) {
    const body = await readJson(req);
    if (typeof body.hidden !== 'boolean') {
      throw new Error('"hidden" must be a boolean.');
    }
    const key = decodeURIComponent(hiddenMatch[1]!);
    await loadForWrite(controls);
    if (!(await setProjectHidden(controls.path, key, body.hidden))) {
      sendError(res, 404, `No project "${key}".`);
      return;
    }
    await controls.reload();
    sendNoContent(res);
    return;
  }

  const projectMatch = PROJECT_ROUTE.exec(route);
  if (projectMatch) {
    const key = decodeURIComponent(projectMatch[1]!);

    // Repair: point the entry at a new path (with `dryRun`, only check it).
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      const entry = await planRepair(
        key,
        optionalString(body.path, 'path') ?? '',
        await loadForWrite(controls),
      );
      if (body.dryRun !== true) {
        await setRegistryEntryPath(controls.path, key, entry.path);
        await controls.reload();
      }
      sendJson(res, 200, { entry });
      return;
    }

    if (req.method === 'DELETE') {
      await loadForWrite(controls);
      const removed = await removeRegistryEntry(controls.path, key);
      if (!removed) {
        sendError(res, 404, `No project "${key}".`);
        return;
      }
      await controls.reload();
      sendNoContent(res);
      return;
    }
  }

  sendError(res, 404, 'Not found');
}
