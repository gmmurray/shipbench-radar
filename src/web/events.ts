// The browser end of the single shared event stream. Every subscriber (the
// tab bar, the registry refresh, and the mounted board) shares one
// EventSource, so Radar holds exactly one long-lived connection however many
// projects are registered. See DESIGN.md, "Architecture".

type ProjectListener = (projectKey: string) => void;
type RegistryListener = () => void;

const projectListeners = new Set<ProjectListener>();
const registryListeners = new Set<RegistryListener>();
let source: EventSource | null = null;

function open(): EventSource {
  const next = new EventSource('/api/events');
  next.addEventListener('tasks-changed', event => {
    const { project } = JSON.parse((event as MessageEvent<string>).data) as {
      project: string;
    };
    for (const listener of projectListeners) listener(project);
  });
  next.addEventListener('registry-changed', () => {
    for (const listener of registryListeners) listener();
  });
  return next;
}

function retain(): void {
  source ??= open();
}

function release(): void {
  if (projectListeners.size === 0 && registryListeners.size === 0) {
    source?.close();
    source = null;
  }
}

/** Call `listener` with the project key of every change. Returns unsubscribe. */
export function subscribeToProjectChanges(
  listener: ProjectListener,
): () => void {
  projectListeners.add(listener);
  retain();
  return () => {
    projectListeners.delete(listener);
    release();
  };
}

/** Call `listener` whenever the server re-reads registry.json. */
export function subscribeToRegistryChanges(
  listener: RegistryListener,
): () => void {
  registryListeners.add(listener);
  retain();
  return () => {
    registryListeners.delete(listener);
    release();
  };
}
