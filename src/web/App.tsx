import { Board } from '@shipbench/board';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import {
  PROJECTS_HREF,
  PROJECTS_PAGE,
  ProjectsPage,
  RepairForm,
} from './ProjectsPage.tsx';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: ProjectList };

// The URL hash names the active project (`#/shipbench`), so a reload or a
// pinned tab lands on the same board. Tabs are links that set it.
// `#/_projects` is the Projects page; keys can't contain `_`.
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

// The last project on screen, for a visit with no hash (the launcher's `o`
// opens the bare URL). A per-browser convenience, so browser storage; it may
// be unavailable, and then Radar just starts on the first project.
const LAST_PROJECT_KEY = 'radar.lastProject';

function readLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function rememberProject(key: string): void {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, key);
  } catch {
    // Storage unavailable; nothing to remember.
  }
}

/**
 * The project the hash names. Without a hash: the last one viewed in this
 * browser, else the first available, else the first.
 */
function pickProject(
  projects: ProjectSummary[],
  hashKey: string | null,
): ProjectSummary | undefined {
  if (hashKey) return projects.find(p => p.key === hashKey);
  const last = readLastProject();
  return (
    projects.find(p => p.key === last) ??
    projects.find(p => p.available) ??
    projects[0]
  );
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

  const onProjectsPage = hashKey === PROJECTS_PAGE;
  const projects = state.status === 'ready' ? state.list.projects : [];
  const active = onProjectsPage ? undefined : pickProject(projects, hashKey);
  const activeKey = active?.key ?? null;

  // The stream listener outlives renders, so it reads the active key from a
  // ref rather than a stale closure.
  const activeKeyRef = useRef(activeKey);
  useEffect(() => {
    activeKeyRef.current = activeKey;
    if (activeKey) rememberProject(activeKey);
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

  // The registry changed: `pnpm radar`, the Projects page, or a hand edit.
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

  // Boards stay mounted once opened, and inactive ones are hidden rather than
  // unmounted, so switching back is instant and keeps the open task, search,
  // and scroll. The board (0.6.0+) sends keyboard shortcuts only to the
  // visible one. See DESIGN.md, "Mounting".
  const boardKey = active?.available ? active.key : null;
  const [opened, setOpened] = useState<readonly string[]>([]);
  useEffect(() => {
    if (boardKey) {
      setOpened(previous =>
        previous.includes(boardKey) ? previous : [...previous, boardKey],
      );
    }
  }, [boardKey]);
  // Include the active board on the render that first shows it, not one
  // render later, and drop any board whose project was removed or became
  // unavailable.
  const mountedBoards = [
    ...opened,
    ...(boardKey && !opened.includes(boardKey) ? [boardKey] : []),
  ].filter(key => projects.some(p => p.key === key && p.available));

  // The page scroll is shared by every board, so remember it per view.
  const viewKey = boardKey ?? `view:${hashKey ?? ''}`;
  const scrollByView = useRef(new Map<string, number>());
  const viewKeyRef = useRef(viewKey);
  useEffect(() => {
    const remember = () =>
      scrollByView.current.set(viewKeyRef.current, window.scrollY);
    window.addEventListener('scroll', remember, { passive: true });
    return () => window.removeEventListener('scroll', remember);
  }, []);
  useLayoutEffect(() => {
    viewKeyRef.current = viewKey;
    window.scrollTo(0, scrollByView.current.get(viewKey) ?? 0);
  }, [viewKey]);

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

  let content: ReactNode = null;
  if (onProjectsPage) {
    content = <ProjectsPage list={list} refresh={refresh} />;
  } else if (list.projects.length === 0) {
    content = (
      <Notice title="No projects registered">
        Add one on the <a href={PROJECTS_HREF}>Projects page</a>, or run{' '}
        <code>pnpm radar add &lt;path&gt;</code> in the Radar repository.
      </Notice>
    );
  } else if (!active) {
    content = (
      <Notice title={`No project named “${hashKey}”`}>
        It isn’t registered. See the <a href={PROJECTS_HREF}>Projects page</a>.
      </Notice>
    );
  } else if (!active.available) {
    content = (
      <Notice title={`${active.name ?? active.key} is unavailable`}>
        <p>{active.reason}</p>
        <p>
          Registered as <code>{active.id}</code>. If the repository moved, point
          Radar at its new location:
        </p>
        <RepairForm project={active} refresh={refresh} />
      </Notice>
    );
  }

  return (
    <div className="radar-shell">
      <TabBar
        projects={list.projects}
        activeKey={activeKey}
        onProjectsPage={onProjectsPage}
        unread={unread}
      />
      {problem}
      <div className="radar-board">
        {mountedBoards.map(key => (
          <div key={key} hidden={key !== boardKey}>
            <BoardHost projectKey={key} visible={key === boardKey} />
          </div>
        ))}
        {content}
      </div>
    </div>
  );
}

function TabBar({
  projects,
  activeKey,
  onProjectsPage,
  unread,
}: {
  projects: ProjectSummary[];
  activeKey: string | null;
  onProjectsPage: boolean;
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
      <a
        href={PROJECTS_HREF}
        className="radar-tab radar-tab-manage"
        aria-current={onProjectsPage ? 'page' : undefined}
        title="Add, reorder, repair, or remove projects"
      >
        <span aria-hidden>+</span> Projects
      </a>
    </nav>
  );
}

/** registry.json changed but couldn't be loaded; the tabs are the last good one. */
function RegistryProblem({ message }: { message: string }) {
  return (
    <div className="radar-problem" role="alert">
      <strong>Registry not reloaded.</strong> Showing the last valid version;
      changes from the Projects page wait until the file is fixed.
      <pre>{message}</pre>
    </div>
  );
}

function BoardHost({
  projectKey,
  visible,
}: {
  projectKey: string;
  visible: boolean;
}) {
  // Stable per project: the board rebuilds its store whenever `api` changes.
  const api = useMemo(() => createProjectApi(projectKey), [projectKey]);
  // Only the visible board names the browser tab.
  return <Board api={api} documentTitle={visible} />;
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="radar-notice">
      <p className="radar-eyebrow">Radar</p>
      <h1>{title}</h1>
      <div className="radar-notice-body">{children}</div>
    </main>
  );
}
