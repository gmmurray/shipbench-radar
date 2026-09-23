import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import {
  createServer,
  type IncomingHttpHeaders,
  request,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAdapter, initProject } from '@shipbench/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectList } from '../shared/types.ts';
import { createRadarHandler } from './app.ts';
import { openProjects } from './projects.ts';

let root: string;
let alphaPath: string;
let server: Server;
let port: number;

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function send(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: options.headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function sendJsonBody(method: string, path: string, value?: unknown) {
  return send(method, path, {
    headers: JSON_HEADERS,
    body: value === undefined ? undefined : JSON.stringify(value),
  });
}

async function taskFiles(): Promise<string[]> {
  return (await readdir(join(alphaPath, '.shipbench', 'tasks'))).filter(f =>
    f.endsWith('.md'),
  );
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'radar-app-'));
  alphaPath = join(root, 'alpha');
  const bareRepoPath = join(root, 'bare');
  const webDir = join(root, 'web');

  await mkdir(alphaPath);
  await initProject(new FsAdapter(alphaPath), { name: 'Alpha' });
  await mkdir(bareRepoPath);
  await mkdir(webDir);
  await writeFile(
    join(webDir, 'index.html'),
    '<!doctype html><title>t</title>',
  );

  const projects = openProjects({
    version: 1,
    ui: {},
    projects: [
      { key: 'alpha', id: 'github.com/me/alpha', path: alphaPath },
      { key: 'gone', id: 'github.com/me/gone', path: join(root, 'missing') },
      { key: 'bare', id: 'github.com/me/bare', path: bareRepoPath },
    ],
  });

  server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  const handler = createRadarHandler({
    projects,
    port,
    webDir,
    registryPath: join(root, 'registry.json'),
  });
  server.on('request', (req, res) => void handler(req, res));
});

afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
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
