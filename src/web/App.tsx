import { Board } from '@shipbench/board';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ProjectList, ProjectSummary } from '../shared/types.ts';
import { createProjectApi, listProjects } from './api.ts';
import {
  subscribeToProjectChanges,
  subscribeToRegistryChanges,
} from './events.ts';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: ProjectList };

// The URL hash names the active project (`#/shipbench`), so a reload or a
// pinned tab lands on the same board. Tabs are links that set it.
function readHashKey(): string | null {
  const match = /^#\/(.+)$/.exec(window.location.hash);
  return match ? decodeURIComponent(match[1]!) : null;
}

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
}

function hrefFor(key: string): string {
  return `#/${encodeURIComponent(key)}`;
}

/** The project the hash names; without a hash, the first available one. */
function pickProject(
  projects: ProjectSummary[],
  hashKey: string | null,
): ProjectSummary | undefined {
  if (hashKey) return projects.find(p => p.key === hashKey);
  return projects.find(p => p.available) ?? projects[0];
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const hashKey = useSyncExternalStore(subscribeToHash, readHashKey);
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());

  // Re-read the list whenever something may have changed a project's name
  // (config.json) or availability. A failed re-read keeps the last good list.
  const refresh = useCallback(() => {
    listProjects().then(
      list => setState({ status: 'ready', list }),
      (error: unknown) =>
        setState(previous =>
          previous.status === 'ready'
            ? previous
            : {
                status: 'error',
                message: error instanceof Error ? error.message : String(error),
              },
        ),
    );
  }, []);

  useEffect(refresh, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const projects = state.status === 'ready' ? state.list.projects : [];
  const active = pickProject(projects, hashKey);
  const activeKey = active?.key ?? null;

  // The stream listener outlives renders, so it reads the active key from a
  // ref rather than a stale closure.
  const activeKeyRef = useRef(activeKey);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  // Mark projects that change while another one is on screen. The mounted
  // board subscribes to the same stream for its own refresh.
  useEffect(
    () =>
      subscribeToProjectChanges(key => {
        if (key !== activeKeyRef.current) {
          setUnread(previous =>
            previous.has(key) ? previous : new Set(previous).add(key),
          );
        }
        refresh();
      }),
    [refresh],
  );

  // `pnpm radar add/remove` (or a hand edit) changed the registry.
  useEffect(() => subscribeToRegistryChanges(refresh), [refresh]);

  // Looking at a project reads it.
  useEffect(() => {
    if (!activeKey) return;
    setUnread(previous => {
      if (!previous.has(activeKey)) return previous;
      const next = new Set(previous);
      next.delete(activeKey);
      return next;
    });
  }, [activeKey]);

  if (state.status === 'loading') return null;

  if (state.status === 'error') {
    return (
      <Notice title="Radar could not load its projects">{state.message}</Notice>
    );
  }

  const { list } = state;
  const problem = list.registryProblem ? (
    <RegistryProblem message={list.registryProblem} />
  ) : null;

  if (list.projects.length === 0) {
    return (
      <>
        {problem}
        <Notice title="No projects registered">
          Run <code>pnpm radar add &lt;path&gt;</code> in the Radar repository.
          This page updates on its own. The registry lives at{' '}
          <code>{list.registryPath}</code>.
        </Notice>
      </>
    );
  }

  let content: ReactNode;
  if (!active) {
    content = (
      <Notice title={`No project named “${hashKey}”`}>
        It isn’t in <code>{list.registryPath}</code>.
      </Notice>
    );
  } else if (!active.available) {
    content = (
      <Notice title={`${active.name ?? active.key} is unavailable`}>
        {active.reason}
        <br />
        Registered as <code>{active.id}</code>.
      </Notice>
    );
  } else {
    // Keyed by project: switching tabs unmounts the old board and mounts a
    // fresh one. See DESIGN.md, "Mounting: one board at a time".
    content = <BoardHost key={active.key} projectKey={active.key} />;
  }

  return (
    <div className="radar-shell">
      <TabBar projects={list.projects} activeKey={activeKey} unread={unread} />
      {problem}
      <div className="radar-board">{content}</div>
    </div>
  );
}

function TabBar({
  projects,
  activeKey,
  unread,
}: {
  projects: ProjectSummary[];
  activeKey: string | null;
  unread: ReadonlySet<string>;
}) {
  return (
    <nav className="radar-tabs" aria-label="Projects">
      <span className="radar-tabs-mark" aria-hidden>
        Radar
      </span>
      <div className="radar-tabs-list">
        {projects.map(project => {
          const isActive = project.key === activeKey;
          const isUnread = unread.has(project.key);
          return (
            <a
              key={project.key}
              href={hrefFor(project.key)}
              className="radar-tab"
              aria-current={isActive ? 'page' : undefined}
              data-unavailable={project.available ? undefined : ''}
              title={
                project.available
                  ? `${project.id}\n${project.path}`
                  : `Unavailable: ${project.reason}`
              }
            >
              <span className="radar-tab-label">
                {project.name ?? project.key}
              </span>
              {isUnread ? (
                <span className="radar-tab-dot">
                  <span className="radar-visually-hidden"> (changed)</span>
                </span>
              ) : null}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/** registry.json changed but couldn't be loaded; the tabs are the last good one. */
function RegistryProblem({ message }: { message: string }) {
  return (
    <div className="radar-problem" role="alert">
      <strong>Registry not reloaded.</strong> Showing the last valid version.
      <pre>{message}</pre>
    </div>
  );
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
