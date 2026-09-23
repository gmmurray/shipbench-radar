import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadRegistry, parseRegistry, RegistryError } from './registry.ts';

const abs = (name: string) => resolve('/repos', name);

function registryJson(projects: unknown, extra: object = {}): string {
  return JSON.stringify({ version: 1, projects, ...extra });
}

function problemsOf(raw: string): string[] {
  try {
    parseRegistry(raw, 'test');
  } catch (error) {
    if (error instanceof RegistryError) return error.problems;
    throw error;
  }
  throw new Error('expected a RegistryError');
}

describe('parseRegistry', () => {
  it('accepts a valid registry and defaults ui', () => {
    const registry = parseRegistry(
      registryJson([
        { key: 'alpha', id: 'github.com/me/alpha', path: abs('a') },
      ]),
      'test',
    );
    expect(registry).toEqual({
      version: 1,
      ui: {},
      projects: [{ key: 'alpha', id: 'github.com/me/alpha', path: abs('a') }],
    });
  });

  it('reports every problem at once', () => {
    const problems = problemsOf(
      registryJson([
        { key: 'Bad Key', id: 'x', path: abs('a') },
        { key: 'ok', id: '', path: 'relative/path' },
      ]),
    );
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/projects\[0\]\.key/);
    expect(problems.join('\n')).toMatch(/projects\[1\]\.id/);
    expect(problems.join('\n')).toMatch(/projects\[1\]\.path/);
  });

  it('rejects duplicate keys and duplicate identities', () => {
    const problems = problemsOf(
      registryJson([
        { key: 'a', id: 'same', path: abs('1') },
        { key: 'a', id: 'other', path: abs('2') },
        { key: 'b', id: 'same', path: abs('3') },
      ]),
    );
    expect(problems).toEqual([
      'projects[1].key "a" is used by another entry',
      'projects[2].id "same" is used by another entry',
    ]);
  });

  it('rejects unparseable JSON, a wrong version, and a non-array projects', () => {
    expect(problemsOf('{')[0]).toMatch(/not valid JSON/);
    expect(problemsOf(JSON.stringify({ version: 2, projects: [] }))).toEqual([
      '"version" must be 1 (got 2)',
    ]);
    expect(problemsOf(JSON.stringify({ version: 1 }))).toContain(
      '"projects" must be an array',
    );
  });
});

describe('registry.example.json', () => {
  // The example is the documented format; keep it loadable.
  it('is a valid registry', async () => {
    const file = fileURLToPath(
      new URL('../../registry.example.json', import.meta.url),
    );
    const registry = await loadRegistry(file);
    expect(registry.projects.length).toBeGreaterThan(0);
  });
});

describe('loadRegistry', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('treats a missing file as an empty registry', async () => {
    dir = await mkdtemp(join(tmpdir(), 'radar-registry-'));
    await expect(loadRegistry(join(dir, 'registry.json'))).resolves.toEqual({
      version: 1,
      projects: [],
      ui: {},
    });
  });

  it('throws on a present but invalid file', async () => {
    dir = await mkdtemp(join(tmpdir(), 'radar-registry-'));
    const file = join(dir, 'registry.json');
    await writeFile(file, '{"version": 1}');
    await expect(loadRegistry(file)).rejects.toBeInstanceOf(RegistryError);
  });
});
