import type { BoardAPI, TaskFrontmatter } from '@shipbench/core';
import type { ProjectList } from '../shared/types.ts';
import { subscribeToProjectChanges } from './events.ts';

// Mirrors the CLI's BoardAPI in ../shipbench/packages/board/src/standalone.tsx,
// with two differences: every path is rooted at `/api/projects/:key`, and
// every write carries `content-type: application/json` — the server rejects
// writes without it (DESIGN.md, "The local server"), including bodiless ones
// like unarchive and delete.

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === 'string') message = body.error;
    } catch {
      // Not JSON; keep the status line.
    }
    throw new Error(message);
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
