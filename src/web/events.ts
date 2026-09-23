// The browser end of the single shared event stream. Every subscriber (the
// tab bar and the mounted board) shares one EventSource, so Radar holds
// exactly one long-lived connection however many projects are registered.
// See DESIGN.md, "Architecture".

type Listener = (projectKey: string) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

function open(): EventSource {
  const next = new EventSource('/api/events');
  next.addEventListener('tasks-changed', event => {
    const { project } = JSON.parse((event as MessageEvent<string>).data) as {
      project: string;
    };
    for (const listener of listeners) listener(project);
  });
  return next;
}

/** Call `listener` with the project key of every change. Returns unsubscribe. */
export function subscribeToProjectChanges(listener: Listener): () => void {
  listeners.add(listener);
  source ??= open();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      source?.close();
      source = null;
    }
  };
}
