import type { BoardAPI, TaskFrontmatter } from '@shipbench/core';
import type {
  EntryShape,
  ProjectList,
  ProjectSuggestion,
  RegistryApiError,
} from '../shared/types.ts';
import { subscribeToProjectChanges } from './events.ts';

// Mirrors the CLI's BoardAPI in ../shipbench/packages/board/src/standalone.tsx,
// with two differences: every path is rooted at `/api/projects/:key`, and
// every write carries `content-type: application/json` — the server rejects
// writes without it (DESIGN.md, "The local server"), including bodiless ones
// like unarchive and delete.

/** A refused request. Registry refusals also say which input to fix. */
export class ApiError extends Error {
  readonly status: number;
  readonly field?: RegistryApiError['field'];
  readonly example?: string;

  constructor(
    status: number,
    body: Partial<RegistryApiError>,
    fallback: string,
  ) {
    super(typeof body.error === 'string' ? body.error : fallback);
    this.name = 'ApiError';
    this.status = status;
    this.field = body.field;
    this.example = body.example;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    let body: Partial<RegistryApiError> = {};
    try {
      body = (await response.json()) as Partial<RegistryApiError>;
    } catch {
      // Not JSON; the status line will do.
    }
    throw new ApiError(
      response.status,
      body,
      `${response.status} ${response.statusText}`,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function write(method: string, value?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  };
}

export function listProjects(): Promise<ProjectList> {
  return request('/api/projects');
}

export interface AdditionInput {
  path: string;
  key?: string;
  id?: string;
}

/**
 * The Projects page's calls. Each write resolves once the server has
 * re-read the registry, so a list fetched afterwards already shows it.
 */
export const registryApi = {
  suggestions: () =>
    request<{ suggestions: ProjectSuggestion[] }>(
      '/api/registry/suggestions',
    ).then(body => body.suggestions),
  preview: (input: AdditionInput) =>
    request<{ entry: EntryShape }>(
      '/api/registry/projects',
      write('POST', { ...input, dryRun: true }),
    ).then(body => body.entry),
  add: (input: AdditionInput) =>
    request<{ entry: EntryShape }>(
      '/api/registry/projects',
      write('POST', input),
    ).then(body => body.entry),
  repair: (key: string, path: string) =>
    request<{ entry: EntryShape }>(
      `/api/registry/projects/${encodeURIComponent(key)}`,
      write('PATCH', { path }),
    ).then(body => body.entry),
  remove: (key: string) =>
    request<void>(
      `/api/registry/projects/${encodeURIComponent(key)}`,
      write('DELETE'),
    ),
  setOrder: (order: string[]) =>
    request<void>('/api/registry/order', write('PUT', { order })),
  setHidden: (key: string, hidden: boolean) =>
    request<void>(
      `/api/registry/projects/${encodeURIComponent(key)}/hidden`,
      write('PUT', { hidden }),
    ),
};

export function createProjectApi(key: string): BoardAPI {
  const base = `/api/projects/${encodeURIComponent(key)}`;
  const task = (slug: string) => `${base}/tasks/${encodeURIComponent(slug)}`;

  return {
    getConfig: () => request(`${base}/config`),
    listTasks: () => request(`${base}/tasks`),
    listArchivedTasks: () => request(`${base}/tasks/archived`),
    createTask: (title: string, fields?: Partial<TaskFrontmatter>) =>
      request(`${base}/tasks`, write('POST', { title, fields })),
    updateTask: (
      slug: string,
      fields: Partial<TaskFrontmatter>,
      body?: string,
    ) => request(task(slug), write('PATCH', { fields, body })),
    addComment: (slug: string, text: string) =>
      request(`${task(slug)}/comments`, write('POST', { text })),
    editComment: (slug: string, index: number, text: string) =>
      request(
        `${task(slug)}/comments/${encodeURIComponent(index)}`,
        write('PATCH', { text }),
      ),
    deleteComment: (slug: string, index: number) =>
      request(
        `${task(slug)}/comments/${encodeURIComponent(index)}`,
        write('DELETE'),
      ),
    async moveTask(slug: string, toStatus: string) {
      const result = await this.reorderTask(slug, toStatus, -1);
      return result.task;
    },
    reorderTask: (slug: string, toStatus: string, position: number) =>
      request(`${task(slug)}/reorder`, write('POST', { toStatus, position })),
    archiveTask: (slug: string, options?: { force?: boolean }) =>
      request(`${task(slug)}/archive`, write('POST', options ?? {})),
    unarchiveTask: (slug: string) =>
      request(`${task(slug)}/unarchive`, write('POST')),
    deleteTask: (slug: string) => request(task(slug), write('DELETE')),
    // The shared stream, filtered to this project.
    onTasksChanged: (callback: () => void) =>
      subscribeToProjectChanges(changed => {
        if (changed === key) callback();
      }),
    // `resolveRepoLink` is absent for the same reason the CLI omits it:
    // serving repo files would make Radar an arbitrary-file server.
  };
}
