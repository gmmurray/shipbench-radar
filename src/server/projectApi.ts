import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  addComment,
  archiveTask,
  createTask,
  deleteComment,
  deleteTask,
  editComment,
  listArchivedTasks,
  listTasks,
  loadConfig,
  reorderTask,
  type StorageAdapter,
  type TaskFrontmatter,
  unarchiveTask,
  updateTask,
} from '@shipbench/core';
import {
  isObject,
  readJson,
  sendError,
  sendJson,
  sendNoContent,
} from './http.ts';

// One project's board API. A route-for-route transcription of the request
// handler in ../shipbench/apps/cli/src/boardServer.ts, rooted at
// `/api/projects/:key` instead of `/api`. Nothing here is invented: every
// route delegates to @shipbench/core.

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`"${field}" must be a string.`);
  }
  return value;
}

function optionalTaskFields(value: unknown): Partial<TaskFrontmatter> {
  if (value === undefined) return {};
  if (!isObject(value)) throw new Error('"fields" must be an object.');
  return value as Partial<TaskFrontmatter>;
}

function optionalBody(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('"body" must be a string.');
  return value;
}

function parsePosition(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('"position" must be an integer.');
  }
  return value;
}

function parseCommentIndex(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error('Task update index must be a non-negative integer.');
  }
  return index;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`"${field}" must be a boolean.`);
  }
  return value;
}

const TASK_ROUTE =
  /^\/tasks\/([^/]+)(?:\/(reorder|archive|unarchive|comments)(?:\/([^/]+))?)?$/;

/**
 * Handle one request. `route` is the path below the project prefix, e.g.
 * `/tasks` or `/tasks/my-task/comments/0`. Errors propagate to the caller,
 * which maps them to status codes.
 */
export async function handleProjectApi(
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
  adapter: StorageAdapter,
  warn?: (line: string) => void,
): Promise<void> {
  const loadProjectConfig = () =>
    loadConfig(adapter, {
      onWarning: warning => warn?.(`${warning.path}: ${warning.message}`),
    });

  if (req.method === 'GET' && route === '/config') {
    sendJson(res, 200, await loadProjectConfig());
    return;
  }

  if (req.method === 'GET' && route === '/tasks') {
    const config = await loadProjectConfig();
    sendJson(res, 200, await listTasks(adapter, config));
    return;
  }

  if (req.method === 'GET' && route === '/tasks/archived') {
    const config = await loadProjectConfig();
    sendJson(res, 200, await listArchivedTasks(adapter, config));
    return;
  }

  if (req.method === 'POST' && route === '/tasks') {
    const body = await readJson(req);
    const config = await loadProjectConfig();
    const task = await createTask(
      adapter,
      config,
      requireString(body.title, 'title'),
      optionalTaskFields(body.fields),
    );
    sendJson(res, 200, task);
    return;
  }

  const taskMatch = TASK_ROUTE.exec(route);
  if (!taskMatch) {
    sendError(res, 404, 'Not found');
    return;
  }

  const slug = decodeURIComponent(taskMatch[1]!);
  const subroute = taskMatch[2];
  const commentIndex = taskMatch[3];

  if (req.method === 'PATCH' && !subroute) {
    const body = await readJson(req);
    const config = await loadProjectConfig();
    const result = await updateTask(
      adapter,
      config,
      slug,
      optionalTaskFields(body.fields),
      optionalBody(body.body),
    );
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && subroute === 'reorder') {
    const body = await readJson(req);
    const config = await loadProjectConfig();
    const result = await reorderTask(
      adapter,
      config,
      slug,
      requireString(body.toStatus, 'toStatus'),
      parsePosition(body.position),
    );
    sendJson(res, 200, result);
    return;
  }

  if (
    req.method === 'POST' &&
    subroute === 'comments' &&
    commentIndex === undefined
  ) {
    const body = await readJson(req);
    const config = await loadProjectConfig();
    sendJson(
      res,
      200,
      await addComment(adapter, config, slug, requireString(body.text, 'text')),
    );
    return;
  }

  if (
    req.method === 'PATCH' &&
    subroute === 'comments' &&
    commentIndex !== undefined
  ) {
    const body = await readJson(req);
    const config = await loadProjectConfig();
    sendJson(
      res,
      200,
      await editComment(
        adapter,
        config,
        slug,
        parseCommentIndex(decodeURIComponent(commentIndex)),
        requireString(body.text, 'text'),
      ),
    );
    return;
  }

  if (
    req.method === 'DELETE' &&
    subroute === 'comments' &&
    commentIndex !== undefined
  ) {
    const config = await loadProjectConfig();
    sendJson(
      res,
      200,
      await deleteComment(
        adapter,
        config,
        slug,
        parseCommentIndex(decodeURIComponent(commentIndex)),
      ),
    );
    return;
  }

  if (req.method === 'POST' && subroute === 'archive') {
    const body = await readJson(req);
    const config = await loadProjectConfig();
    await archiveTask(adapter, config, slug, {
      force: optionalBoolean(body.force, 'force'),
    });
    sendNoContent(res);
    return;
  }

  if (req.method === 'POST' && subroute === 'unarchive') {
    const config = await loadProjectConfig();
    sendJson(res, 200, await unarchiveTask(adapter, config, slug));
    return;
  }

  if (req.method === 'DELETE' && !subroute) {
    const config = await loadProjectConfig();
    await deleteTask(adapter, config, slug);
    sendNoContent(res);
    return;
  }

  sendError(res, 404, 'Not found');
}
