import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAdapter, initProject } from '@shipbench/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  EntryShape,
  ProjectList,
  ProjectSuggestion,
  RegistryApiError,
} from '../shared/types.ts';
import { type RunningRadar, startRadar } from './radar.ts';
import { loadRegistry } from './registry.ts';
import { addRegistryEntry } from './registryFile.ts';
import { send, sendJson, waitFor } from './testSupport.ts';

// The Projects page's API against a live server and real git checkouts.
// Tests run in order and build on each other's registry state.

let root: string;
let registryPath: string;
let radar: RunningRadar;
const paths: Record<string, string> = {};

async function makeRepo(
  name: string,
  options: { remote?: string; shipbench?: boolean } = {},
): Promise<string> {
  const path = join(root, 'repos', name);
  await mkdir(path, { recursive: true });
  if (options.remote) {
    execFileSync('git', ['init', '-q', path]);
    execFileSync('git', [
      '-C',
      path,
      'remote',
      'add',
      'origin',
      options.remote,
    ]);
  }
  if (options.shipbench !== false) {
    await initProject(new FsAdapter(path), { name });
  }
  paths[name] = path;
  return path;
}

const call = (method: string, path: string, value?: unknown) =>
  sendJson(radar.port, method, `/api/registry${path}`, value);

async function projects(): Promise<ProjectList['projects']> {
  const reply = await send(radar.port, 'GET', '/api/projects');
  return (JSON.parse(reply.body) as ProjectList).projects;
}

const keys = async () => (await projects()).map(p => p.key);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'radar-registry-api-'));
  registryPath = join(root, 'home', 'registry.json');
  await makeRepo('alpha', { remote: 'git@github.com:me/alpha.git' });
  await makeRepo('beta', { remote: 'https://github.com/me/beta.git' });
  await makeRepo('Loose Notes');
  await makeRepo('plain', { shipbench: false });

  await addRegistryEntry(registryPath, {
    key: 'alpha',
    id: 'github.com/me/alpha',
    path: paths.alpha!,
  });
  await mkdir(join(root, 'web'));
  radar = await startRadar({
    registry: await loadRegistry(registryPath),
    registryPath,
    port: 0,
    webDir: join(root, 'web'),
  });
});

afterAll(async () => {
  await radar.close();
  await rm(root, { recursive: true, force: true });
});

describe('registry API', () => {
  it('suggests unregistered ShipBench projects beside registered ones', async () => {
    const reply = await send(radar.port, 'GET', '/api/registry/suggestions');
    const { suggestions } = JSON.parse(reply.body) as {
      suggestions: ProjectSuggestion[];
    };
    expect(suggestions.map(s => s.name)).toEqual(['beta', 'Loose Notes']);
  });

  it('previews an addition without writing it', async () => {
    const before = await readFile(registryPath, 'utf-8');
    const reply = await call('POST', '/projects', {
      path: paths.beta,
      dryRun: true,
    });
    expect(reply.status).toBe(200);
    expect((JSON.parse(reply.body) as { entry: EntryShape }).entry).toEqual({
      key: 'beta',
      id: 'github.com/me/beta',
      path: paths.beta,
    });
    expect(await readFile(registryPath, 'utf-8')).toBe(before);
  });

  it('adds, and the next project list already has it', async () => {
    expect((await call('POST', '/projects', { path: paths.beta })).status).toBe(
      200,
    );
    expect(await keys()).toEqual(['alpha', 'beta']);
  });

  it('names the field to fix, with an example identity', async () => {
    const reply = await call('POST', '/projects', {
      path: paths['Loose Notes'],
    });
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body) as RegistryApiError).toMatchObject({
      field: 'id',
      example: 'local/Loose Notes',
    });

    const added = await call('POST', '/projects', {
      path: paths['Loose Notes'],
      id: 'local/notes',
    });
    expect((JSON.parse(added.body) as { entry: EntryShape }).entry.key).toBe(
      'loose-notes',
    );
  });

  it('refuses a key clash and a non-ShipBench directory', async () => {
    const clash = await call('POST', '/projects', {
      path: paths.plain,
    });
    expect(clash.status).toBe(400);
    expect((JSON.parse(clash.body) as RegistryApiError).field).toBe('path');

    const other = await makeRepo('beta-fork', {
      remote: 'git@github.com:you/beta-fork.git',
    });
    const taken = await call('POST', '/projects', { path: other, key: 'beta' });
    expect(taken.status).toBe(409);
    expect((JSON.parse(taken.body) as RegistryApiError).field).toBe('key');
  });

  it('saves tab order as ui.order and serves projects in it', async () => {
    const reply = await call('PUT', '/order', {
      order: ['loose-notes', 'nope', 'beta'],
    });
    expect(reply.status).toBe(204);
    expect(await keys()).toEqual(['loose-notes', 'beta', 'alpha']);

    const saved = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(saved.ui.order).toEqual(['loose-notes', 'beta']);
    expect(saved.projects.map((p: EntryShape) => p.key)).toEqual([
      'alpha',
      'beta',
      'loose-notes',
    ]);
  });

  it('repairs a moved repository, but only with the same identity', async () => {
    // Windows won't rename a folder Radar is watching, so a real move happens
    // while Radar is stopped. Model the result: an entry whose old path is
    // gone, and the checkout at its new place.
    const moved = await makeRepo('gamma-moved', {
      remote: 'git@github.com:me/gamma.git',
    });
    await addRegistryEntry(registryPath, {
      key: 'gamma',
      id: 'github.com/me/gamma',
      path: join(root, 'repos', 'gamma-old'),
    });
    await waitFor(async () => (await keys()).includes('gamma'));
    expect((await projects()).find(p => p.key === 'gamma')?.available).toBe(
      false,
    );

    const wrong = await call('PATCH', '/projects/gamma', { path: paths.beta });
    expect(wrong.status).toBe(409);
    expect((JSON.parse(wrong.body) as RegistryApiError).error).toMatch(
      /is github\.com\/me\/beta, not github\.com\/me\/gamma/,
    );

    const fixed = await call('PATCH', '/projects/gamma', { path: moved });
    expect(fixed.status).toBe(200);
    const gamma = (await projects()).find(p => p.key === 'gamma');
    expect(gamma).toMatchObject({ available: true, path: moved });
  });

  it('removes an entry and drops it from the saved order', async () => {
    expect((await call('DELETE', '/projects/beta')).status).toBe(204);
    expect(await keys()).toEqual(['loose-notes', 'alpha', 'gamma']);
    const saved = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(saved.ui.order).toEqual(['loose-notes']);

    expect((await call('DELETE', '/projects/beta')).status).toBe(404);
  });

  it('refuses writes while registry.json is broken', async () => {
    const good = await readFile(registryPath, 'utf-8');
    await writeFile(registryPath, '{ nope');
    try {
      const reply = await call('DELETE', '/projects/alpha');
      expect(reply.status).toBe(409);
      expect((JSON.parse(reply.body) as RegistryApiError).error).toMatch(
        /fix it before changing projects/,
      );
    } finally {
      await writeFile(registryPath, good);
    }
  });

  it('accepts writes only as JSON, like every other write', async () => {
    const before = await readFile(registryPath, 'utf-8');
    const reply = await send(radar.port, 'POST', '/api/registry/projects', {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ path: paths.plain }),
    });
    expect(reply.status).toBe(415);
    expect(await readFile(registryPath, 'utf-8')).toBe(before);
  });
});

describe('hiding tabs', () => {
  const hidden = async () =>
    (JSON.parse(await readFile(registryPath, 'utf-8')).ui.hidden ??
      []) as string[];

  it('hides and shows a tab without unregistering the project', async () => {
    expect(
      (await call('PUT', '/projects/gamma/hidden', { hidden: true })).status,
    ).toBe(204);
    const gamma = (await projects()).find(p => p.key === 'gamma');
    expect(gamma).toMatchObject({ hidden: true, available: true });
    expect(await hidden()).toEqual(['gamma']);
    // Still served: hiding is display only.
    expect(
      (await send(radar.port, 'GET', '/api/projects/gamma/tasks')).status,
    ).toBe(200);

    expect(
      (await call('PUT', '/projects/gamma/hidden', { hidden: false })).status,
    ).toBe(204);
    expect((await projects()).find(p => p.key === 'gamma')?.hidden).toBe(false);
    expect(await hidden()).toEqual([]);
  });

  it('rejects a non-boolean and an unknown key', async () => {
    expect(
      (await call('PUT', '/projects/gamma/hidden', { hidden: 'yes' })).status,
    ).toBe(400);
    expect(
      (await call('PUT', '/projects/nope/hidden', { hidden: true })).status,
    ).toBe(404);
  });

  it('drops a removed project from ui.hidden', async () => {
    await call('PUT', '/projects/loose-notes/hidden', { hidden: true });
    expect(await hidden()).toEqual(['loose-notes']);
    expect((await call('DELETE', '/projects/loose-notes')).status).toBe(204);
    expect(await hidden()).toEqual([]);
  });
});
