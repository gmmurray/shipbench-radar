import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAdapter, initProject } from '@shipbench/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectList } from '../shared/types.ts';
import { type RunningRadar, startRadar } from './radar.ts';
import {
  JSON_HEADERS,
  openEventStream as openStream,
  sendJson,
  send as sendTo,
  TASK_FILE,
  waitFor,
} from './testSupport.ts';

let root: string;
let alphaPath: string;
let betaPath: string;
let radar: RunningRadar;
let port: number;

const send = (
  method: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: string },
) => sendTo(port, method, path, options);
const sendJsonBody = (method: string, path: string, value?: unknown) =>
  sendJson(port, method, path, value);
const openEventStream = () => openStream(port);

async function taskFiles(): Promise<string[]> {
  return (await readdir(join(alphaPath, '.shipbench', 'tasks'))).filter(f =>
    f.endsWith('.md'),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'radar-app-'));
  alphaPath = join(root, 'alpha');
  betaPath = join(root, 'beta');
  const bareRepoPath = join(root, 'bare');
  const webDir = join(root, 'web');

  await mkdir(alphaPath);
  await initProject(new FsAdapter(alphaPath), { name: 'Alpha' });
  await mkdir(betaPath);
  await initProject(new FsAdapter(betaPath), { name: 'Beta' });
  await mkdir(bareRepoPath);
  await mkdir(webDir);
  await writeFile(
    join(webDir, 'index.html'),
    '<!doctype html><title>t</title>',
  );

  radar = await startRadar({
    registry: {
      version: 1,
      ui: {},
      projects: [
        { key: 'alpha', id: 'github.com/me/alpha', path: alphaPath },
        { key: 'beta', id: 'github.com/me/beta', path: betaPath },
        { key: 'gone', id: 'github.com/me/gone', path: join(root, 'missing') },
        { key: 'bare', id: 'github.com/me/bare', path: bareRepoPath },
      ],
    },
    registryPath: join(root, 'registry.json'),
    port: 0,
    webDir,
  });
  port = radar.port;
});

afterAll(async () => {
  await radar.close();
  await rm(root, { recursive: true, force: true });
});

describe('event stream', () => {
  it('reports an outside write to a project, tagged with its key', async () => {
    const stream = await openEventStream();
    try {
      await writeFile(
        join(betaPath, '.shipbench', 'tasks', 'agent-task.md'),
        TASK_FILE,
      );
      await waitFor(() => stream.projects().includes('beta'));
      expect(stream.projects()).not.toContain('alpha');
    } finally {
      stream.close();
    }
  });

  it('reports Radar-originated writes too, one stream for every client', async () => {
    const first = await openEventStream();
    const second = await openEventStream();
    try {
      await sendJsonBody('POST', '/api/projects/alpha/tasks', {
        title: 'Seen by both streams',
      });
      await waitFor(
        () =>
          first.projects().includes('alpha') &&
          second.projects().includes('alpha'),
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it('coalesces a burst of writes into one event', async () => {
    const stream = await openEventStream();
    try {
      for (let i = 0; i < 5; i++) {
        await writeFile(
          join(betaPath, '.shipbench', 'tasks', `burst-${i}.md`),
          TASK_FILE,
        );
      }
      await waitFor(() => stream.projects().includes('beta'));
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(stream.projects().filter(key => key === 'beta')).toHaveLength(1);
    } finally {
      stream.close();
    }
  });
});

describe('project list', () => {
  it('reports each entry, with a reason for unavailable ones', async () => {
    const reply = await send('GET', '/api/projects');
    expect(reply.status).toBe(200);

    const list = JSON.parse(reply.body) as ProjectList;
    expect(list.registryPath).toBe(join(root, 'registry.json'));

    const byKey = Object.fromEntries(list.projects.map(p => [p.key, p]));
    expect(byKey.alpha).toMatchObject({ available: true, name: 'Alpha' });
    expect(byKey.gone).toMatchObject({ available: false, name: null });
    expect(byKey.gone?.reason).toMatch(/Path not found/);
    expect(byKey.bare).toMatchObject({ available: false });
    expect(byKey.bare?.reason).toMatch(/No \.shipbench\//);
  });
});

describe('project API', () => {
  it('writes tasks into the repository itself', async () => {
    const created = await sendJsonBody('POST', '/api/projects/alpha/tasks', {
      title: 'Written by Radar',
    });
    expect(created.status).toBe(200);
    const task = JSON.parse(created.body) as { slug: string };

    expect(await taskFiles()).toContain(`${task.slug}.md`);

    const listed = await send('GET', '/api/projects/alpha/tasks');
    expect(listed.status).toBe(200);
    expect(listed.body).toContain('Written by Radar');
  });

  it('serves config, archive, unarchive, and delete', async () => {
    const config = await send('GET', '/api/projects/alpha/config');
    expect(JSON.parse(config.body)).toMatchObject({ name: 'Alpha' });

    const created = await sendJsonBody('POST', '/api/projects/alpha/tasks', {
      title: 'Round trip',
    });
    const { slug } = JSON.parse(created.body) as { slug: string };
    const taskPath = `/api/projects/alpha/tasks/${slug}`;

    expect((await sendJsonBody('POST', `${taskPath}/archive`, {})).status).toBe(
      204,
    );
    // Bodiless writes still carry the JSON content type.
    expect((await sendJsonBody('POST', `${taskPath}/unarchive`)).status).toBe(
      200,
    );
    expect((await sendJsonBody('DELETE', taskPath)).status).toBe(204);
    expect(await taskFiles()).not.toContain(`${slug}.md`);
  });

  it('maps core errors to status codes', async () => {
    const missing = await sendJsonBody(
      'PATCH',
      '/api/projects/alpha/tasks/no-such-task',
      { fields: { title: 'x' } },
    );
    expect(missing.status).toBe(404);

    const invalid = await sendJsonBody('POST', '/api/projects/alpha/tasks', {
      title: 42,
    });
    expect(invalid.status).toBe(400);

    const malformed = await send('POST', '/api/projects/alpha/tasks', {
      headers: JSON_HEADERS,
      body: '{not json',
    });
    expect(malformed.status).toBe(400);
  });

  it('refuses unavailable and unknown projects', async () => {
    const gone = await send('GET', '/api/projects/gone/tasks');
    expect(gone.status).toBe(503);
    expect(gone.body).toMatch(/unavailable/);

    const unknown = await send('GET', '/api/projects/nope/tasks');
    expect(unknown.status).toBe(404);
  });
});

describe('request checks', () => {
  it('rejects a no-preflight text/plain write and writes nothing', async () => {
    const before = await taskFiles();
    const reply = await send('POST', '/api/projects/alpha/tasks', {
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ title: 'CSRF' }),
    });
    expect(reply.status).toBe(415);
    expect(await taskFiles()).toEqual(before);
  });

  it('rejects a foreign Origin even with a JSON body', async () => {
    const before = await taskFiles();
    const reply = await send('POST', '/api/projects/alpha/tasks', {
      headers: { ...JSON_HEADERS, origin: 'https://evil.example' },
      body: JSON.stringify({ title: 'CSRF' }),
    });
    expect(reply.status).toBe(403);
    expect(await taskFiles()).toEqual(before);
  });

  it('rejects an opaque "null" Origin', async () => {
    const reply = await send('GET', '/api/projects', {
      headers: { origin: 'null' },
    });
    expect(reply.status).toBe(403);
  });

  it('accepts its own Origin', async () => {
    const reply = await send('GET', '/api/projects', {
      headers: { origin: `http://localhost:${port}` },
    });
    expect(reply.status).toBe(200);
  });

  it.each(['/api/projects', '/api/projects/alpha/tasks', '/'])(
    'rejects a foreign Host on %s (DNS rebinding)',
    async path => {
      const reply = await send('GET', path, {
        headers: { host: `rebind.example:${port}` },
      });
      expect(reply.status).toBe(403);
    },
  );

  it('rejects the right host on the wrong port', async () => {
    const reply = await send('GET', '/api/projects', {
      headers: { host: `127.0.0.1:${port + 1}` },
    });
    expect(reply.status).toBe(403);
  });
});

describe('static files', () => {
  it('serves the built page at /', async () => {
    const reply = await send('GET', '/');
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toMatch(/text\/html/);
  });

  it('does not serve outside the web directory', async () => {
    const reply = await send('GET', '/..%2F..%2Fregistry.json');
    expect([403, 404]).toContain(reply.status);
  });
});
