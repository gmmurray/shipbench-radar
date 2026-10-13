import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProjectList, ProjectSummary } from '../shared/types.ts';
import type { EventHub } from './events.ts';
import { coreErrorStatus, sendError, sendJson } from './http.ts';
import { handleProjectApi } from './projectApi.ts';
import { inspectProject, type Project } from './projects.ts';
import { hiddenKeys } from './registry.ts';
import { handleRegistryApi, type RegistryControls } from './registryApi.ts';
import { checkRequest } from './security.ts';
import { serveStatic } from './static.ts';

export interface RadarAppOptions {
  /** Current projects, in tab order. The caller may replace entries between requests. */
  projects: Map<string, Project>;
  events: EventHub;
  registry: RegistryControls;
  /** The port actually bound; the Host and Origin checks depend on it. */
  port: number;
  /** Extra allowed origins; in dev, Vite's. */
  extraOrigins?: readonly string[];
  webDir: string;
  /** Receives non-fatal project read warnings. */
  warn?: (line: string) => void;
}

const PROJECT_ROUTE = /^\/api\/projects\/([^/]+)(\/.*)?$/;

async function summarize(
  project: Project,
  hidden: Set<string>,
): Promise<ProjectSummary> {
  const { key, id, path } = project.entry;
  const base = { key, id, path, hidden: hidden.has(key) };
  const status = await inspectProject(project);
  return status.available
    ? { ...base, name: status.config.name, available: true }
    : { ...base, name: null, available: false, reason: status.reason };
}

export function createRadarHandler(
  options: RadarAppOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const rejection = checkRequest(req, options);
    if (rejection) {
      sendError(res, rejection.status, rejection.message);
      return;
    }

    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/api/events') {
      options.events.attach(req, res);
      return;
    }

    if (url.pathname === '/api/projects') {
      if (req.method !== 'GET') {
        sendError(res, 404, 'Not found');
        return;
      }
      const hidden = hiddenKeys(options.registry.current());
      const body: ProjectList = {
        registryPath: options.registry.path,
        projects: await Promise.all(
          [...options.projects.values()].map(project =>
            summarize(project, hidden),
          ),
        ),
      };
      const problem = options.registry.problem();
      if (problem) body.registryProblem = problem;
      sendJson(res, 200, body);
      return;
    }

    if (url.pathname.startsWith('/api/registry/')) {
      await handleRegistryApi(
        req,
        res,
        url.pathname.slice('/api/registry'.length),
        options.registry,
      );
      return;
    }

    const projectMatch = PROJECT_ROUTE.exec(url.pathname);
    if (projectMatch) {
      const key = decodeURIComponent(projectMatch[1]!);
      const project = options.projects.get(key);
      if (!project) {
        sendError(res, 404, `No registered project "${key}".`);
        return;
      }

      const status = await inspectProject(project);
      if (!status.available) {
        sendError(
          res,
          503,
          `Project "${key}" is unavailable: ${status.reason}`,
        );
        return;
      }

      await handleProjectApi(
        req,
        res,
        projectMatch[2] ?? '/',
        project.adapter,
        options.warn,
      );
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendError(res, 404, 'Not found');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendError(res, 404, 'Not found');
      return;
    }

    await serveStatic(req, res, options.webDir);
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      const status =
        error instanceof SyntaxError ? 400 : coreErrorStatus(error);
      const message =
        error instanceof Error && status !== 500
          ? error.message
          : 'Internal server error';
      if (status === 500) console.error(error);
      if (!res.headersSent) sendError(res, status, message);
      else res.end();
    }
  };
}
