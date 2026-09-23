import { Board } from '@shipbench/board';
import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ProjectList, ProjectSummary } from '../shared/types.ts';
import { createProjectApi, listProjects } from './api.ts';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: ProjectList };

// The URL hash names the active project (`#/shipbench`), so a reload or a
// pinned tab lands on the same board. The tab bar that sets it arrives in M2.
function readHashKey(): string | null {
  const match = /^#\/(.+)$/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function pickProject(
  projects: ProjectSummary[],
  hashKey: string | null,
): ProjectSummary | undefined {
  if (hashKey) {
    const named = projects.find(p => p.key === hashKey);
    if (named) return named;
  }
  return projects.find(p => p.available) ?? projects[0];
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const hashKey = useSyncExternalStore(subscribeToHash, readHashKey);

  useEffect(() => {
    listProjects().then(
      list => setState({ status: 'ready', list }),
      (error: unknown) =>
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        }),
    );
  }, []);

  if (state.status === 'loading') return null;

  if (state.status === 'error') {
    return (
      <Notice title="Radar could not load its projects">{state.message}</Notice>
    );
  }

  const { list } = state;
  if (list.projects.length === 0) {
    return (
      <Notice title="No projects registered">
        Add entries to <code>{list.registryPath}</code> and restart Radar. Copy{' '}
        <code>registry.example.json</code> from the Radar repository to start.
      </Notice>
    );
  }

  if (hashKey && !list.projects.some(p => p.key === hashKey)) {
    return (
      <Notice title={`No project named “${hashKey}”`}>
        It isn’t in <code>{list.registryPath}</code>.
      </Notice>
    );
  }

  const project = pickProject(list.projects, hashKey)!;
  if (!project.available) {
    return (
      <Notice title={`${project.key} is unavailable`}>
        {project.reason}
        <br />
        Registered as <code>{project.id}</code>.
      </Notice>
    );
  }

  // Keyed by project: switching projects unmounts the old board and mounts a
  // fresh one. See DESIGN.md, "Mounting: one board at a time".
  return <BoardHost key={project.key} projectKey={project.key} />;
}

function BoardHost({ projectKey }: { projectKey: string }) {
  // Stable per project: the board rebuilds its store whenever `api` changes.
  const api = useMemo(() => createProjectApi(projectKey), [projectKey]);
  return <Board api={api} documentTitle />;
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="radar-notice">
      <p className="radar-notice-eyebrow">Radar</p>
      <h1>{title}</h1>
      <p>{children}</p>
    </main>
  );
}
