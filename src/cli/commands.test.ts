import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsAdapter, initProject } from '@shipbench/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRegistry } from '../server/registry.ts';
import { runCli } from './commands.ts';

let root: string;
let registryPath: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'radar-cli-'));
  registryPath = join(root, 'home', 'registry.json');
  out = [];
  err = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function cli(...argv: string[]): Promise<number> {
  return runCli(argv, {
    cwd: root,
    registryPath,
    out: line => out.push(line),
    err: line => err.push(line),
  });
}

/** A directory with a ShipBench project and, optionally, a git origin. */
async function makeRepo(
  name: string,
  options: { remote?: string; shipbench?: boolean } = {},
): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  if (options.remote !== undefined) {
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
  return path;
}

async function entries() {
  return (await loadRegistry(registryPath)).projects;
}

describe('add', () => {
  it('takes identity and key from the GitHub origin', async () => {
    const path = await makeRepo('checkout', {
      remote: 'git@github.com:Me/Alpha-Repo.git',
    });

    expect(await cli('add', path)).toBe(0);
    expect(await entries()).toEqual([
      { key: 'alpha-repo', id: 'github.com/me/alpha-repo', path },
    ]);
  });

  it('resolves a relative path against the invoking directory', async () => {
    const path = await makeRepo('rel', {
      remote: 'https://github.com/me/rel.git',
    });
    expect(await cli('add', 'rel')).toBe(0);
    expect((await entries())[0]?.path).toBe(path);
  });

  it('requires --id without a remote, then keys from the directory', async () => {
    const path = await makeRepo('My Scratch');

    expect(await cli('add', path)).toBe(1);
    expect(err.join('\n')).toMatch(/no origin remote.*--id local\/My Scratch/s);
    expect(existsSync(registryPath)).toBe(false);

    expect(await cli('add', path, '--id', 'local/scratch')).toBe(0);
    expect(await entries()).toEqual([
      { key: 'my-scratch', id: 'local/scratch', path },
    ]);
  });

  it('explains a non-GitHub origin', async () => {
    const path = await makeRepo('gl', {
      remote: 'https://gitlab.com/me/gl.git',
    });
    expect(await cli('add', path)).toBe(1);
    expect(err.join('\n')).toMatch(/not a GitHub URL/);
  });

  it('refuses a directory that is not a ShipBench project', async () => {
    const path = await makeRepo('plain', {
      remote: 'https://github.com/me/plain.git',
      shipbench: false,
    });
    expect(await cli('add', path)).toBe(1);
    expect(err.join('\n')).toMatch(/shipbench init/);
    expect(existsSync(registryPath)).toBe(false);
  });

  it('treats a second checkout of one repository as the same project', async () => {
    const first = await makeRepo('one', {
      remote: 'git@github.com:me/same.git',
    });
    const second = await makeRepo('two', {
      remote: 'https://github.com/me/same',
    });

    expect(await cli('add', first)).toBe(0);
    expect(await cli('add', second, '--key', 'other')).toBe(1);
    expect(err.join('\n')).toMatch(/already registered as "same"/);
  });

  it('rejects a duplicate key, and accepts --key instead', async () => {
    const a = await makeRepo('a/web', { remote: 'git@github.com:me/web.git' });
    const b = await makeRepo('b/web', { remote: 'git@github.com:you/web.git' });

    expect(await cli('add', a)).toBe(0);
    expect(await cli('add', b)).toBe(1);
    expect(err.join('\n')).toMatch(/key "web" is already used.*--key/s);

    expect(await cli('add', b, '--key', 'your-web')).toBe(0);
    expect((await entries()).map(e => e.key)).toEqual(['web', 'your-web']);
  });

  it('rejects the same path under a second identity', async () => {
    const path = await makeRepo('p');
    expect(await cli('add', path, '--id', 'local/one')).toBe(0);
    expect(await cli('add', path, '--id', 'local/two', '--key', 'p2')).toBe(1);
    expect(err.join('\n')).toMatch(/already registered as "p"/);
  });

  it('rejects an invalid --key', async () => {
    const path = await makeRepo('k', { remote: 'git@github.com:me/k.git' });
    expect(await cli('add', path, '--key', 'Bad Key')).toBe(1);
    expect(err.join('\n')).toMatch(/Invalid key/);
  });
});

describe('list and remove', () => {
  it('lists availability, with the reason for a missing project', async () => {
    const path = await makeRepo('here', {
      remote: 'git@github.com:me/here.git',
    });
    const gone = await makeRepo('gone', {
      remote: 'git@github.com:me/gone.git',
    });
    await cli('add', path);
    await cli('add', gone);
    await rm(gone, { recursive: true, force: true });

    out = [];
    expect(await cli('list')).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/here\s+ok\s+github\.com\/me\/here/);
    expect(text).toMatch(/gone\s+missing\s+github\.com\/me\/gone/);
    expect(text).toMatch(/Path not found/);
  });

  it('says how to start when nothing is registered', async () => {
    expect(await cli('list')).toBe(0);
    expect(out.join('\n')).toMatch(/pnpm radar add <path>/);
  });

  it('removes an entry and leaves the repository alone', async () => {
    const path = await makeRepo('r', { remote: 'git@github.com:me/r.git' });
    await cli('add', path);

    expect(await cli('remove', 'r')).toBe(0);
    expect(await entries()).toEqual([]);
    expect(existsSync(join(path, '.shipbench', 'config.json'))).toBe(true);
  });

  it('names the registered keys when removing an unknown one', async () => {
    const path = await makeRepo('r', { remote: 'git@github.com:me/r.git' });
    await cli('add', path);
    expect(await cli('remove', 'nope')).toBe(1);
    expect(err.join('\n')).toMatch(/Registered keys: r\./);
  });
});

describe('move', () => {
  it('repoints an entry at a checkout of the same repository only', async () => {
    const first = await makeRepo('old/m', {
      remote: 'git@github.com:me/m.git',
    });
    const other = await makeRepo('other', {
      remote: 'git@github.com:me/other.git',
    });
    const second = await makeRepo('new/m', {
      remote: 'https://github.com/me/m.git',
    });
    await cli('add', first);

    expect(await cli('move', 'm', other)).toBe(1);
    expect(err.join('\n')).toMatch(
      /is github\.com\/me\/other, not github\.com\/me\/m/,
    );

    expect(await cli('move', 'm', 'new/m')).toBe(0);
    expect(await entries()).toEqual([
      { key: 'm', id: 'github.com/me/m', path: second },
    ]);
  });
});

describe('show and hide', () => {
  it('hides a tab, lists it as hidden, and shows it again', async () => {
    const path = await makeRepo('h', { remote: 'git@github.com:me/h.git' });
    await cli('add', path);

    expect(await cli('hide', 'h')).toBe(0);
    out = [];
    await cli('list');
    expect(out.join('\n')).toMatch(/h\s+ok\s+github\.com\/me\/h\s+\(hidden\)/);

    expect(await cli('show', 'h')).toBe(0);
    out = [];
    await cli('list');
    expect(out.join('\n')).not.toMatch(/hidden/);

    expect(await cli('hide', 'nope')).toBe(1);
    expect(err.join('\n')).toMatch(/Registered keys: h\./);
  });
});

describe('registry round trip', () => {
  it('preserves ui and unknown fields across add and remove', async () => {
    const existing = await makeRepo('kept');
    await mkdir(join(root, 'home'));
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        projects: [
          { key: 'kept', id: 'local/kept', path: existing, note: 'mine' },
        ],
        ui: { order: ['kept'] },
        futureField: true,
      }),
    );

    const path = await makeRepo('new', { remote: 'git@github.com:me/new.git' });
    expect(await cli('add', path)).toBe(0);
    expect(await cli('remove', 'new')).toBe(0);

    const data = JSON.parse(await readFile(registryPath, 'utf-8'));
    expect(data).toEqual({
      version: 1,
      projects: [
        { key: 'kept', id: 'local/kept', path: existing, note: 'mine' },
      ],
      ui: { order: ['kept'] },
      futureField: true,
    });
  });
});

describe('usage', () => {
  it('fails on an unknown command or option', async () => {
    expect(await cli('frobnicate')).toBe(1);
    expect(await cli('add', '.', '--nope')).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: pnpm radar/);
  });
});
