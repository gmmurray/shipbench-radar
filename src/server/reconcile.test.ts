import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAdapter, initProject } from '@shipbench/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectList } from '../shared/types.ts';
import { type RunningRadar, startRadar } from './radar.ts';
import { loadRegistry } from './registry.ts';
import { addRegistryEntry, removeRegistryEntry } from './registryFile.ts';
import {
  type EventStream,
  openEventStream,
  send,
  TASK_FILE,
  waitFor,
} from './testSupport.ts';

// A running Radar follows registry.json: entries added, removed, or broken on
// disk reach the server without a restart.

let root: string;
let registryPath: string;
let radar: RunningRadar;
let stream: EventStream;

async function makeProject(name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(path);
  await initProject(new FsAdapter(path), { name });
  return path;
}

async function projectList(): Promise<ProjectList> {
  const reply = await send(radar.port, 'GET', '/api/projects');
  return JSON.parse(reply.body) as ProjectList;
}

function registryEvents(): number {
  return stream.events.filter(e => e.event === 'registry-changed').length;
}

/** Run `change`, then wait for the server to announce it re-read the registry. */
async function afterReload(change: () => Promise<unknown>): Promise<void> {
  const before = registryEvents();
  await change();
  await waitFor(() => registryEvents() > before);
}

async function keys(): Promise<string[]> {
  return (await projectList()).projects.map(p => p.key);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'radar-reconcile-'));
  registryPath = join(root, 'home', 'registry.json');
  const alpha = await makeProject('alpha');
  await addRegistryEntry(registryPath, {
    key: 'alpha',
    id: 'local/alpha',
    path: alpha,
  });

  const webDir = join(root, 'web');
  await mkdir(webDir);
  radar = await startRadar({
    registry: await loadRegistry(registryPath),
    registryPath,
    port: 0,
    webDir,
  });
  stream = await openEventStream(radar.port);
});

afterAll(async () => {
  stream.close();
  await radar.close();
  await rm(root, { recursive: true, force: true });
});

describe('registry reconciling', () => {
  it('serves and watches a project added while running', async () => {
    const beta = await makeProject('beta');
    await afterReload(() =>
      addRegistryEntry(registryPath, {
        key: 'beta',
        id: 'local/beta',
        path: beta,
      }),
    );

    expect(await keys()).toEqual(['alpha', 'beta']);
    expect(
      (await send(radar.port, 'GET', '/api/projects/beta/tasks')).status,
    ).toBe(200);

    await writeFile(join(beta, '.shipbench', 'tasks', 'agent.md'), TASK_FILE);
    await waitFor(() => stream.projects().includes('beta'));
  });

  it('drops a removed project and stops watching it', async () => {
    const alphaPath = join(root, 'alpha');
    await afterReload(() => removeRegistryEntry(registryPath, 'alpha'));

    expect(await keys()).toEqual(['beta']);
    expect(
      (await send(radar.port, 'GET', '/api/projects/alpha/tasks')).status,
    ).toBe(404);

    const seen = stream.projects().length;
    await writeFile(
      join(alphaPath, '.shipbench', 'tasks', 'late.md'),
      TASK_FILE,
    );
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(stream.projects().slice(seen)).not.toContain('alpha');
  });

  it('starts watching a project whose directory appeared since startup', async () => {
    const latePath = join(root, 'late');
    await afterReload(() =>
      addRegistryEntry(registryPath, {
        key: 'late',
        id: 'local/late',
        path: latePath,
      }),
    );
    expect(
      (await projectList()).projects.find(p => p.key === 'late'),
    ).toMatchObject({ available: false });

    await makeProject('late');
    // Any registry change retries watchers that couldn't start before.
    const extra = await makeProject('extra');
    await afterReload(() =>
      addRegistryEntry(registryPath, {
        key: 'extra',
        id: 'local/extra',
        path: extra,
      }),
    );

    await writeFile(join(latePath, '.shipbench', 'tasks', 'now.md'), TASK_FILE);
    await waitFor(() => stream.projects().includes('late'));
  });

  it('keeps the last good registry when the file breaks, and recovers', async () => {
    const good = await keys();

    await afterReload(() => writeFile(registryPath, '{ "version": 1, '));
    const broken = await projectList();
    expect(broken.projects.map(p => p.key)).toEqual(good);
    expect(broken.registryProblem).toMatch(/not valid JSON/);

    await afterReload(() =>
      writeFile(
        registryPath,
        JSON.stringify({ version: 1, projects: [], ui: {} }),
      ),
    );
    const recovered = await projectList();
    expect(recovered.registryProblem).toBeUndefined();
    expect(recovered.projects).toEqual([]);
  });
});
