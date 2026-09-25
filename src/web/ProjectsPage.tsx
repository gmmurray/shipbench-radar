import {
  type DragEvent,
  type FormEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  EntryShape,
  ProjectList,
  ProjectSuggestion,
  ProjectSummary,
} from '../shared/types.ts';
import { ApiError, registryApi } from './api.ts';

// The Projects page (#/_projects): reorder tabs, repair moved repositories,
// remove entries, and add new ones, with suggestions from beside the
// registered repositories. Every rule is the server's (registration.ts, shared
// with `pnpm radar`); this page only asks and shows the answer.

/** Keys can't contain `_`, so this address can't clash with a project. */
export const PROJECTS_PAGE = '_projects';
export const PROJECTS_HREF = `#/${PROJECTS_PAGE}`;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function labelOf(project: ProjectSummary): string {
  return project.name ?? project.key;
}

export function ProjectsPage({
  list,
  refresh,
}: {
  list: ProjectList;
  refresh: () => void;
}) {
  const [addPath, setAddPath] = useState('');
  const pathInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previous = document.title;
    document.title = 'Projects — Radar';
    return () => {
      document.title = previous;
    };
  }, []);

  function chooseSuggestion(path: string) {
    setAddPath(path);
    pathInput.current?.focus();
  }

  return (
    <main className="radar-page">
      <p className="radar-eyebrow">Radar</p>
      <h1>Projects</h1>
      <p className="radar-hint">
        Registry: <code>{list.registryPath}</code>. Changes here and from{' '}
        <code>pnpm radar</code> follow the same rules.
      </p>

      <section className="radar-section">
        <h2>Tabs</h2>
        {list.projects.length === 0 ? (
          <p className="radar-hint">No projects registered yet.</p>
        ) : (
          <ProjectRows projects={list.projects} refresh={refresh} />
        )}
      </section>

      <section className="radar-section">
        <h2>Add a project</h2>
        <AddProject
          path={addPath}
          onPathChange={setAddPath}
          pathInput={pathInput}
          refresh={refresh}
        />
        <Suggestions
          version={list.projects.map(p => `${p.key}=${p.path}`).join('|')}
          onUse={chooseSuggestion}
        />
      </section>
    </main>
  );
}

// ---- Tab order, repair, remove ---------------------------------------------

function ProjectRows({
  projects,
  refresh,
}: {
  projects: ProjectSummary[];
  refresh: () => void;
}) {
  const serverOrder = projects.map(p => p.key);
  const [order, setOrder] = useState(serverOrder);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Follow the server whenever the list changes under us.
  const serverOrderKey = serverOrder.join('\n');
  useEffect(() => {
    setOrder(serverOrderKey.split('\n'));
  }, [serverOrderKey]);

  const byKey = new Map(projects.map(p => [p.key, p]));

  async function save(next: string[]) {
    setOrder(next);
    setError(null);
    try {
      await registryApi.setOrder(next);
      refresh();
    } catch (err) {
      setError(messageOf(err));
      setOrder(serverOrder);
    }
  }

  function moveBy(key: string, delta: number) {
    const from = order.indexOf(key);
    const to = from + delta;
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    [next[from], next[to]] = [next[to]!, next[from]!];
    void save(next);
  }

  function dropOn(target: string) {
    if (!dragKey || dragKey === target) return;
    const movingDown = order.indexOf(dragKey) < order.indexOf(target);
    const next = order.filter(key => key !== dragKey);
    next.splice(next.indexOf(target) + (movingDown ? 1 : 0), 0, dragKey);
    void save(next);
  }

  return (
    <>
      <p className="radar-hint">
        Drag to reorder, or use the arrows. The order is saved in the registry
        as <code>ui.order</code>.
      </p>
      {error ? (
        <p className="radar-error" role="alert">
          {error}
        </p>
      ) : null}
      <ol className="radar-rows">
        {order.map((key, index) => {
          const project = byKey.get(key);
          if (!project) return null;
          return (
            <ProjectRow
              key={key}
              project={project}
              first={index === 0}
              last={index === order.length - 1}
              dragging={dragKey === key}
              onMove={delta => moveBy(key, delta)}
              onDragStart={() => setDragKey(key)}
              onDragEnd={() => setDragKey(null)}
              onDrop={() => dropOn(key)}
              refresh={refresh}
            />
          );
        })}
      </ol>
    </>
  );
}

function ProjectRow({
  project,
  first,
  last,
  dragging,
  onMove,
  onDragStart,
  onDragEnd,
  onDrop,
  refresh,
}: {
  project: ProjectSummary;
  first: boolean;
  last: boolean;
  dragging: boolean;
  onMove: (delta: number) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  refresh: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'repair' | 'remove'>('idle');
  const label = labelOf(project);

  function startDrag(event: DragEvent) {
    // Firefox only starts a drag that carries data.
    event.dataTransfer.setData('text/plain', project.key);
    event.dataTransfer.effectAllowed = 'move';
    onDragStart();
  }

  return (
    <li
      className="radar-row"
      data-dragging={dragging ? '' : undefined}
      // Not draggable while a form is open, so selecting text in it works.
      draggable={mode === 'idle'}
      onDragStart={startDrag}
      onDragEnd={onDragEnd}
      onDragOver={event => event.preventDefault()}
      onDrop={event => {
        event.preventDefault();
        onDrop();
      }}
    >
      <span className="radar-row-grip" aria-hidden>
        ⠿
      </span>
      <div className="radar-row-main">
        <div className="radar-row-title">
          <a href={`#/${encodeURIComponent(project.key)}`}>{label}</a>
          <span
            className="radar-status"
            data-state={project.available ? 'ok' : 'missing'}
          >
            {project.available ? 'ok' : 'missing'}
          </span>
        </div>
        <div className="radar-row-meta">
          {project.key} · {project.id}
        </div>
        <div className="radar-row-meta">{project.path}</div>
        {project.available ? null : (
          <div className="radar-row-reason">{project.reason}</div>
        )}
        {mode === 'repair' ? (
          <RepairForm
            project={project}
            onDone={() => setMode('idle')}
            refresh={refresh}
          />
        ) : null}
        {mode === 'remove' ? (
          <RemoveConfirm
            project={project}
            onDone={() => setMode('idle')}
            refresh={refresh}
          />
        ) : null}
      </div>
      <div className="radar-row-actions">
        <button
          type="button"
          className="radar-button radar-button-icon"
          disabled={first}
          aria-label={`Move ${label} up`}
          onClick={() => onMove(-1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="radar-button radar-button-icon"
          disabled={last}
          aria-label={`Move ${label} down`}
          onClick={() => onMove(1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="radar-button"
          aria-expanded={mode === 'repair'}
          onClick={() => setMode(mode === 'repair' ? 'idle' : 'repair')}
        >
          Change path
        </button>
        <button
          type="button"
          className="radar-button"
          aria-expanded={mode === 'remove'}
          onClick={() => setMode(mode === 'remove' ? 'idle' : 'remove')}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

/** Point a project at its moved checkout. Also used on an unavailable tab. */
export function RepairForm({
  project,
  onDone,
  refresh,
}: {
  project: ProjectSummary;
  onDone?: () => void;
  refresh: () => void;
}) {
  const [path, setPath] = useState(project.path);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await registryApi.repair(project.key, path);
      refresh();
      onDone?.();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="radar-inline-form" onSubmit={submit}>
      <label className="radar-field">
        <span>New path</span>
        <input
          className="radar-input"
          value={path}
          onChange={event => setPath(event.target.value)}
          spellCheck={false}
          aria-invalid={error ? true : undefined}
        />
      </label>
      <p className="radar-hint">
        {project.id.startsWith('github.com/')
          ? `The checkout there must have ${project.id} as its origin.`
          : 'Point it at the moved checkout.'}
      </p>
      {error ? (
        <p className="radar-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="radar-form-actions">
        <button
          type="submit"
          className="radar-button radar-button-primary"
          disabled={busy || !path.trim() || path === project.path}
        >
          Save path
        </button>
        {onDone ? (
          <button type="button" className="radar-button" onClick={onDone}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

function RemoveConfirm({
  project,
  onDone,
  refresh,
}: {
  project: ProjectSummary;
  onDone: () => void;
  refresh: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await registryApi.remove(project.key);
      refresh();
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <div className="radar-inline-form">
      <p>
        Remove <strong>{labelOf(project)}</strong> from Radar? Its repository
        isn't touched, and it can be added again later.
      </p>
      {error ? (
        <p className="radar-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="radar-form-actions">
        <button
          type="button"
          className="radar-button radar-button-danger"
          disabled={busy}
          onClick={remove}
        >
          Remove
        </button>
        <button type="button" className="radar-button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- Adding -----------------------------------------------------------------

interface Preview {
  checking: boolean;
  entry?: EntryShape;
  error?: ApiError | Error;
}

const PREVIEW_DELAY_MS = 350;

function AddProject({
  path,
  onPathChange,
  pathInput,
  refresh,
}: {
  path: string;
  onPathChange: (path: string) => void;
  pathInput: RefObject<HTMLInputElement | null>;
  refresh: () => void;
}) {
  const [key, setKey] = useState('');
  const [id, setId] = useState('');
  const [preview, setPreview] = useState<Preview>({ checking: false });
  const [added, setAdded] = useState<EntryShape | null>(null);
  const [busy, setBusy] = useState(false);

  // A new path, typed or picked from a suggestion, starts a new addition.
  useEffect(() => {
    if (path) setAdded(null);
  }, [path]);

  // Ask the server what this would add, a moment after typing stops.
  useEffect(() => {
    if (!path.trim()) {
      setPreview({ checking: false });
      return;
    }
    let cancelled = false;
    setPreview(previous => ({ ...previous, checking: true }));
    const timer = setTimeout(() => {
      registryApi
        .preview({ path, key: key || undefined, id: id || undefined })
        .then(
          entry => {
            if (!cancelled) setPreview({ checking: false, entry });
          },
          (error: unknown) => {
            if (!cancelled) {
              setPreview({
                checking: false,
                error:
                  error instanceof Error ? error : new Error(String(error)),
              });
            }
          },
        );
    }, PREVIEW_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [path, key, id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const entry = await registryApi.add({
        path,
        key: key || undefined,
        id: id || undefined,
      });
      setAdded(entry);
      onPathChange('');
      setKey('');
      setId('');
      refresh();
    } catch (err) {
      setPreview({
        checking: false,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      setBusy(false);
    }
  }

  const field =
    preview.error instanceof ApiError ? preview.error.field : undefined;
  const example =
    preview.error instanceof ApiError ? preview.error.example : undefined;

  return (
    <form className="radar-add" onSubmit={submit}>
      <label className="radar-field">
        <span>Path</span>
        <input
          ref={pathInput}
          className="radar-input"
          value={path}
          placeholder="Q:\code\personal\my-repo"
          spellCheck={false}
          aria-invalid={field === 'path' ? true : undefined}
          onChange={event => onPathChange(event.target.value)}
        />
      </label>
      <div className="radar-field-row">
        <label className="radar-field">
          <span>Key</span>
          <input
            className="radar-input"
            value={key}
            placeholder={preview.entry?.key ?? 'from the repository name'}
            spellCheck={false}
            aria-invalid={field === 'key' ? true : undefined}
            onChange={event => setKey(event.target.value)}
          />
        </label>
        <label className="radar-field">
          <span>Identity</span>
          <input
            className="radar-input"
            value={id}
            placeholder={preview.entry?.id ?? 'from the GitHub origin'}
            spellCheck={false}
            aria-invalid={field === 'id' ? true : undefined}
            onChange={event => setId(event.target.value)}
          />
        </label>
      </div>

      <div className="radar-preview" aria-live="polite">
        {preview.checking ? <p className="radar-hint">Checking…</p> : null}
        {!preview.checking && preview.entry ? (
          <p className="radar-hint">
            Adds <strong>{preview.entry.key}</strong> as{' '}
            <code>{preview.entry.id}</code>
          </p>
        ) : null}
        {!preview.checking && preview.error ? (
          <div className="radar-error" role="alert">
            <p>{preview.error.message}</p>
            {field === 'id' && example ? (
              <button
                type="button"
                className="radar-button"
                onClick={() => setId(example)}
              >
                Use {example}
              </button>
            ) : null}
          </div>
        ) : null}
        {added ? (
          <p className="radar-success">
            Added <a href={`#/${encodeURIComponent(added.key)}`}>{added.key}</a>
            .
          </p>
        ) : null}
      </div>

      <div className="radar-form-actions">
        <button
          type="submit"
          className="radar-button radar-button-primary"
          disabled={busy || preview.checking || !preview.entry}
        >
          Add project
        </button>
      </div>
    </form>
  );
}

function Suggestions({
  version,
  onUse,
}: {
  /** Changes whenever the registry does, so suggestions refresh with it. */
  version: string;
  onUse: (path: string) => void;
}) {
  const [items, setItems] = useState<ProjectSuggestion[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // `version` is the refresh trigger; the request itself takes no input.
    void version;
    registryApi.suggestions().then(
      found => {
        if (!cancelled) setItems(found);
      },
      () => {
        if (!cancelled) setItems([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  if (items === null) return null;

  return (
    <div className="radar-suggestions">
      <h3>Next to your projects</h3>
      {items.length === 0 ? (
        <p className="radar-hint">
          No unregistered ShipBench projects beside the registered ones.
        </p>
      ) : (
        <ul className="radar-rows">
          {items.map(item => (
            <li key={item.path} className="radar-row radar-row-compact">
              <div className="radar-row-main">
                <div className="radar-row-title">{item.name}</div>
                <div className="radar-row-meta">{item.path}</div>
              </div>
              <div className="radar-row-actions">
                <button
                  type="button"
                  className="radar-button"
                  onClick={() => onUse(item.path)}
                >
                  Use
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
