// Types shared by the server and the web app. Type-only: this file is part of
// both the Node and the browser TypeScript programs, so it must not import
// anything with a runtime.

export interface ProjectSummary {
  /** Radar's short local handle, used in URLs. */
  key: string;
  /** Portable identity, e.g. `github.com/owner/repo`. */
  id: string;
  /** Machine-local absolute path to the repository. */
  path: string;
  /** `config.name` when the project is available, otherwise null. */
  name: string | null;
  available: boolean;
  /** Why the project can't be loaded; present only when unavailable. */
  reason?: string;
}

export interface ProjectList {
  /** Where the registry lives, so an empty list can say what to edit. */
  registryPath: string;
  projects: ProjectSummary[];
  /**
   * Set when registry.json changed on disk but couldn't be loaded. The
   * projects above are then the last good registry, still being served.
   */
  registryProblem?: string;
}
