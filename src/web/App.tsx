import { Board, type BoardNavigation } from '@shipbench/board';
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
import { createProjectApi, listProjects, registryApi } from './api.ts';
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
import {
  hrefFor,
  parseHash,
  type RouteState,
  trailFromState,
} from './route.ts';
import { titleFor } from './title.ts';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; list: ProjectList };

// The URL hash names the open project and its open task (src/web/route.ts).
function readHashKey(): string | null {
  return parseHash(window.location.hash).key;
}

// A board's own navigation writes the URL with pushState, which fires no
// event; back and forward fire popstate, and typed or linked URLs fire
// hashchange.
function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange);
  window.addEventListener('popstate', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
    window.removeEventListener('popstate', onChange);
  };
}

/** How long the "Hidden · Undo" message stays up after closing a tab. */
const UNDO_MS = 6000;

/** How long the title announces a change before settling on the dot. */
const FLASH_MS = 3000;

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
 * The project the hash names, shown or hidden: asking for a hidden project
 * by name opens it (and App then restores its tab). Without a hash: the last
 * one viewed in this browser if its tab is shown, else the first available
 * shown project, else the first shown.
 */
function pickProject(
  projects: ProjectSummary[],
  hashKey: string | null,
): ProjectSummary | undefined {
  if (hashKey) return projects.find(p => p.key === hashKey);
  const shown = projects.filter(p => !p.hidden);
  const last = readLastProject();
  return (
    shown.find(p => p.key === last) ?? shown.find(p => p.available) ?? shown[0]
  );
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const hashKey = useSyncExternalStore(subscribeToHash, readHashKey);
  const [unread, setUnread] = useState<ReadonlySet<string>>(() => new Set());
  // The browser tab's title reports changes made while the window was in
  // the background; see `titleFor`.
  const [activeUnseen, setActiveUnseen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

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
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  // Each board's open task, as its navigation last reported it. Tab links
  // carry it, so switching back to a project keeps its task in the URL.
  const [openTasks, setOpenTasks] = useState<
    Readonly<Record<string, string | null>>
  >({});
  const openTasksRef = useRef(openTasks);
  openTasksRef.current = openTasks;
  // Per mounted board, the function that opens a task on the host's behalf.
  const selectors = useRef(
    new Map<string, (task: string | null, trail?: readonly string[]) => void>(),
  );
  // One navigation object per project, made when its board first mounts.
  const navigations = useRef(new Map<string, BoardNavigation>());
  const navigationFor = useCallback((key: string): BoardNavigation => {
    const existing = navigations.current.get(key);
    if (existing) return existing;
    const taskInUrl = () => {
      const route = parseHash(window.location.hash);
      return route.key === key ? route.task : null;
    };
    const navigation: BoardNavigation = {
      // Getters, read when the board builds its store: a board that unmounts
      // (its project hidden) and mounts again starts from the URL as it is
      // then, not as it was the first time.
      get initialTaskSlug() {
        return taskInUrl();
      },
      get initialTrail() {
        return trailFromState(window.history.state, key, taskInUrl());
      },
      onSelectedTaskChange(task, { push, trail }) {
        setOpenTasks(previous =>
          previous[key] === task ? previous : { ...previous, [key]: task },
        );
        // Only the board on screen owns the URL. A hidden board's change (a
        // task archived while it was hidden) is remembered for its tab link.
        if (parseHash(window.location.hash).key !== key) return;
        const state: RouteState = {
          radarProject: key,
          radarTask: task,
          trail: [...trail],
        };
        const url = hrefFor(key, task);
        if (push) window.history.pushState(state, '', url);
        else window.history.replaceState(state, '', url);
      },
      // No `back`: history is shared by every project, so "back one step"
      // could land on another project. The board walks its own trail and
      // reports each step, which lands in history like any other.
      subscribe(select) {
        selectors.current.set(key, select);
        return () => {
          selectors.current.delete(key);
          // Unmounted: its tab no longer has an open task to return to.
          setOpenTasks(previous => {
            if (!(key in previous)) return previous;
            const { [key]: _gone, ...rest } = previous;
            return rest;
          });
        };
      },
    };
    navigations.current.set(key, navigation);
    return navigation;
  }, []);

  // Back, forward, a typed URL, or a bookmark: open the task the URL names on
  // that project's board, if it's mounted and showing something else.
  useEffect(() => {
    const follow = (event?: Event) => {
      const { key, task } = parseHash(window.location.hash);
      if (!key) return;
      const select = selectors.current.get(key);
      if (!select || (openTasksRef.current[key] ?? null) === task) return;
      setOpenTasks(previous => ({ ...previous, [key]: task }));
      const state =
        event instanceof PopStateEvent ? event.state : window.history.state;
      select(task, trailFromState(state, key, task));
    };
    window.addEventListener('popstate', follow);
    window.addEventListener('hashchange', follow);
    return () => {
      window.removeEventListener('popstate', follow);
      window.removeEventListener('hashchange', follow);
    };
  }, []);

  // Radar owns the browser tab's title; the boards' own titling is off.
  const title = titleFor({
    label: onProjectsPage ? 'Projects' : (active?.name ?? active?.key ?? null),
    unseen: unread.size + (activeUnseen ? 1 : 0),
    flash,
  });
  useEffect(() => {
    document.title = title;
  }, [title]);

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
        const away = !document.hasFocus();
        if (key !== activeKeyRef.current) {
          setUnread(previous =>
            previous.has(key) ? previous : new Set(previous).add(key),
          );
        } else if (away) {
          // The open project changed while the window was in the background:
          // nothing on the page marks that, so the title does.
          setActiveUnseen(true);
        }
        if (away) {
          const project = projectsRef.current.find(p => p.key === key);
          setFlash(project?.name ?? key);
        }
        refresh();
      }),
    [refresh],
  );

  // Coming back to the window has seen the open project's change.
  useEffect(() => {
    const onFocus = () => {
      setActiveUnseen(false);
      setFlash(null);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  useEffect(() => {
    if (activeKey) setActiveUnseen(false);
  }, [activeKey]);
  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

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

  // A link to a hidden project (a bookmark, a pinned tab, the Projects menu)
  // opens it and restores its tab: asking for it by name means it's wanted.
  const unhiding = useRef<string | null>(null);
  useEffect(() => {
    if (!active?.hidden || unhiding.current === active.key) return;
    unhiding.current = active.key;
    // Restored another way, so its "Hid … · Undo" message is moot.
    const restored = active.key;
    setUndo(previous => (previous?.key === restored ? null : previous));
    registryApi
      .setHidden(active.key, false)
      .then(refresh, () => undefined)
      .finally(() => {
        unhiding.current = null;
      });
  }, [active?.key, active?.hidden, refresh]);

  // Hiding a tab: leave it if it's open, then hide it, with a brief undo.
  const [undo, setUndo] = useState<{ key: string; label: string } | null>(null);
  const hideProject = useCallback(
    (key: string) => {
      const shown = projects.filter(p => !p.hidden);
      const project = shown.find(p => p.key === key);
      if (!project) return;
      if (key === activeKey) {
        const index = shown.indexOf(project);
        const neighbour = shown[index + 1] ?? shown[index - 1];
        window.location.hash = neighbour
          ? hrefFor(neighbour.key)
          : PROJECTS_HREF;
      }
      registryApi.setHidden(key, true).then(refresh, () => undefined);
      setUndo({ key, label: project.name ?? project.key });
    },
    [projects, activeKey, refresh],
  );
  const undoHide = useCallback(() => {
    if (!undo) return;
    // Opening it by name restores the tab (see the effect above).
    window.location.hash = hrefFor(undo.key);
    setUndo(null);
  }, [undo]);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undo]);

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
  // render later, and drop any board whose project was removed, became
  // unavailable, or had its tab hidden.
  const mountedBoards = [
    ...opened,
    ...(boardKey && !opened.includes(boardKey) ? [boardKey] : []),
  ].filter(key =>
    projects.some(
      p => p.key === key && p.available && (!p.hidden || p.key === boardKey),
    ),
  );

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
        openTasks={openTasks}
        onProjectsPage={onProjectsPage}
        unread={unread}
        onHide={hideProject}
      />
      {problem}
      <div className="radar-board">
        {mountedBoards.map(key => (
          <div key={key} hidden={key !== boardKey}>
            <BoardHost projectKey={key} navigation={navigationFor(key)} />
          </div>
        ))}
        {content}
      </div>
      {undo ? (
        <div className="radar-toast" role="status">
          Hid <strong>{undo.label}</strong>
          <button type="button" className="radar-button" onClick={undoHide}>
            Undo
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChangeDot() {
  return (
    <span className="radar-tab-dot">
      <span className="radar-visually-hidden"> (changed)</span>
    </span>
  );
}

function TabBar({
  projects,
  activeKey,
  openTasks,
  onProjectsPage,
  unread,
  onHide,
}: {
  projects: ProjectSummary[];
  activeKey: string | null;
  /** Each project's open task, so a tab returns to it. */
  openTasks: Readonly<Record<string, string | null>>;
  onProjectsPage: boolean;
  unread: ReadonlySet<string>;
  onHide: (key: string) => void;
}) {
  const shown = projects.filter(p => !p.hidden);
  const hidden = projects.filter(p => p.hidden);
  return (
    <nav className="radar-tabs" aria-label="Projects">
      <span className="radar-tabs-mark" aria-hidden>
        Radar
      </span>
      <div className="radar-tabs-list">
        {shown.map(project => {
          const label = project.name ?? project.key;
          return (
            <div key={project.key} className="radar-tab-wrap">
              <a
                href={hrefFor(project.key, openTasks[project.key])}
                className="radar-tab"
                aria-current={project.key === activeKey ? 'page' : undefined}
                data-unavailable={project.available ? undefined : ''}
                title={
                  project.available
                    ? `${project.id}\n${project.path}`
                    : `Unavailable: ${project.reason}`
                }
              >
                <span className="radar-tab-label">{label}</span>
                {unread.has(project.key) ? <ChangeDot /> : null}
              </a>
              <button
                type="button"
                className="radar-tab-close"
                aria-label={`Hide ${label}`}
                title="Hide this tab (the project stays registered)"
                onClick={() => onHide(project.key)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <ProjectsMenu
        hidden={hidden}
        unread={unread}
        onProjectsPage={onProjectsPage}
      />
    </nav>
  );
}

/**
 * The end of the tab bar: reopen a hidden project, or go to the Projects
 * page. Hidden projects that changed carry the same dot a tab would.
 */
function ProjectsMenu({
  hidden,
  unread,
  onProjectsPage,
}: {
  hidden: ProjectSummary[];
  unread: ReadonlySet<string>;
  onProjectsPage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const anyUnread = hidden.some(p => unread.has(p.key));

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // Escape closes the menu and goes no further. Capturing on document runs
    // before the visible board's own Escape listener on window, which would
    // otherwise also close its open task.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open]);

  return (
    <div ref={menuRef} className="radar-menu">
      <button
        type="button"
        className="radar-tab radar-tab-manage"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-current={onProjectsPage ? 'page' : undefined}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden>+</span> Projects
        {hidden.length > 0 ? (
          <span className="radar-menu-count">{hidden.length}</span>
        ) : null}
        {anyUnread ? <ChangeDot /> : null}
      </button>
      {open ? (
        <div className="radar-menu-panel" role="menu">
          {hidden.length === 0 ? (
            <p className="radar-menu-empty">No hidden projects.</p>
          ) : (
            <>
              <p className="radar-menu-heading">Hidden projects</p>
              {hidden.map(project => (
                <a
                  key={project.key}
                  role="menuitem"
                  href={hrefFor(project.key)}
                  className="radar-menu-item"
                  onClick={() => setOpen(false)}
                >
                  <span className="radar-tab-label">
                    {project.name ?? project.key}
                  </span>
                  {unread.has(project.key) ? <ChangeDot /> : null}
                </a>
              ))}
            </>
          )}
          <a
            role="menuitem"
            href={PROJECTS_HREF}
            className="radar-menu-item radar-menu-manage"
            onClick={() => setOpen(false)}
          >
            Manage projects…
          </a>
        </div>
      ) : null}
    </div>
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
  navigation,
}: {
  projectKey: string;
  /** Keeps the open task in Radar's URL; stable per project. */
  navigation: BoardNavigation;
}) {
  // Stable per project: the board rebuilds its store whenever `api` changes.
  const api = useMemo(() => createProjectApi(projectKey), [projectKey]);
  // `documentTitle` stays off: App owns the browser tab's title (`titleFor`).
  return <Board api={api} navigation={navigation} />;
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
