// Radar's URL: the hash names the open project and, optionally, the task
// open on its board: `#/shipbench` or `#/shipbench/fix-the-thing`. A reload,
// a pinned tab, a bookmark, and the browser's back and forward all go through
// it. `#/_projects` is the Projects page; keys can't contain `_`, and task
// slugs can't contain `/` (core rejects them), so the split is unambiguous.

export interface Route {
  key: string | null;
  task: string | null;
}

export function parseHash(hash: string): Route {
  const match = /^#\/([^/]+)(?:\/(.+))?$/.exec(hash);
  if (!match) return { key: null, task: null };
  return {
    key: decodeURIComponent(match[1]!),
    task: match[2] ? decodeURIComponent(match[2]) : null,
  };
}

export function hrefFor(key: string, task?: string | null): string {
  const project = `#/${encodeURIComponent(key)}`;
  return task ? `${project}/${encodeURIComponent(task)}` : project;
}

/**
 * What Radar records in each history entry a board's navigation writes. The
 * trail is the board's "Back to …" chain, handed back to the board on a
 * reload or when the browser returns to that entry.
 */
export interface RouteState {
  radarProject: string;
  radarTask: string | null;
  trail: string[];
}

/** The trail stored with a history entry, when it's one Radar wrote for this task. */
export function trailFromState(
  state: unknown,
  key: string,
  task: string | null,
): string[] | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const s = state as Partial<RouteState>;
  return s.radarProject === key &&
    s.radarTask === task &&
    Array.isArray(s.trail) &&
    s.trail.every(slug => typeof slug === 'string')
    ? s.trail
    : undefined;
}
