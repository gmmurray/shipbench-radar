import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectProject, openProject } from '../server/projects.ts';
import {
  KEY_PATTERN,
  loadRegistry,
  type RegistryEntry,
  RegistryError,
} from '../server/registry.ts';
import {
  addRegistryEntry,
  removeRegistryEntry,
} from '../server/registryFile.ts';
import {
  directoryName,
  githubIdentity,
  readOriginUrl,
  suggestKey,
} from './identity.ts';

// `pnpm radar <command>`: explicit registration (DESIGN.md, "v1 plan" › M3).
// A running Radar watches registry.json, so every change here reaches it
// without a restart.

export interface CliContext {
  /** Where relative paths resolve from: the user's shell, not the package. */
  cwd: string;
  registryPath: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

const USAGE = `Usage: pnpm radar <command>

Commands:
  add <path> [--key <key>] [--id <id>]
      Register a ShipBench project. The identity comes from the GitHub
      "origin" remote; a repository without one needs --id (e.g.
      local/<name>). The key, used in Radar's URLs, defaults to the
      repository name.
  list
      Show every registered project and whether it is available.
  remove <key>
      Unregister a project. Its repository is not touched.`;

/** Thrown for a user-facing failure; its message is the whole report. */
class CliError extends Error {}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b);
}

async function add(args: string[], context: CliContext): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { key: { type: 'string' }, id: { type: 'string' } },
  });
  if (positionals.length !== 1) {
    throw new CliError(`add takes exactly one path.\n\n${USAGE}`);
  }

  const path = resolve(context.cwd, positionals[0]!);

  const status = await inspectProject(openProject({ key: '-', id: '-', path }));
  if (!status.available) {
    throw new CliError(
      `${status.reason}\nRegister a ShipBench project: run \`shipbench init\` there first.`,
    );
  }

  let id = values.id?.trim();
  let repoName: string | null = null;
  const remote = await readOriginUrl(path);
  const github = remote ? githubIdentity(remote) : null;
  if (github) repoName = github.repo;
  if (!id) {
    if (!github) {
      throw new CliError(
        remote
          ? `The origin remote (${remote}) is not a GitHub URL.\nPass an identity with --id, e.g. --id local/${directoryName(path)}.`
          : `${path} has no origin remote.\nPass an identity with --id, e.g. --id local/${directoryName(path)}.`,
      );
    }
    id = github.id;
  }

  const key =
    values.key ?? suggestKey(repoName ?? directoryName(path)) ?? undefined;
  if (!key) {
    throw new CliError(
      `Couldn't derive a key from "${repoName ?? directoryName(path)}". Pass one with --key.`,
    );
  }
  if (!KEY_PATTERN.test(key)) {
    throw new CliError(
      `Invalid key "${key}": use lowercase letters, digits, and hyphens.`,
    );
  }

  const registry = await loadRegistry(context.registryPath);
  for (const existing of registry.projects) {
    if (existing.key === key) {
      throw new CliError(
        `The key "${key}" is already used by ${existing.id} (${existing.path}).\nPick another with --key.`,
      );
    }
    if (existing.id === id) {
      throw new CliError(
        `${id} is already registered as "${existing.key}" (${existing.path}).\nRadar treats every checkout of one repository as one project; remove the old entry first to move it.`,
      );
    }
    if (samePath(existing.path, path)) {
      throw new CliError(
        `${path} is already registered as "${existing.key}" (${existing.id}).`,
      );
    }
  }

  const entry: RegistryEntry = { key, id, path };
  await addRegistryEntry(context.registryPath, entry);
  context.out(`Added "${key}": ${id}`);
  context.out(`  ${path}`);
  context.out(`Registry: ${context.registryPath}`);
}

async function list(args: string[], context: CliContext): Promise<void> {
  if (args.length > 0)
    throw new CliError(`list takes no arguments.\n\n${USAGE}`);

  const registry = await loadRegistry(context.registryPath);
  context.out(`Registry: ${context.registryPath}`);
  if (registry.projects.length === 0) {
    context.out('No projects registered. Add one with: pnpm radar add <path>');
    return;
  }

  const width = Math.max(...registry.projects.map(p => p.key.length));
  for (const entry of registry.projects) {
    const status = await inspectProject(openProject(entry));
    const mark = status.available ? 'ok     ' : 'missing';
    context.out(`  ${entry.key.padEnd(width)}  ${mark}  ${entry.id}`);
    context.out(`  ${' '.repeat(width)}           ${entry.path}`);
    if (!status.available) {
      context.out(`  ${' '.repeat(width)}           ${status.reason}`);
    }
  }
}

async function remove(args: string[], context: CliContext): Promise<void> {
  if (args.length !== 1)
    throw new CliError(`remove takes one key.\n\n${USAGE}`);
  const key = args[0]!;

  const removed = await removeRegistryEntry(context.registryPath, key);
  if (!removed) {
    const registry = await loadRegistry(context.registryPath);
    const keys = registry.projects.map(p => p.key).join(', ') || 'none';
    throw new CliError(`No project "${key}". Registered keys: ${keys}.`);
  }
  context.out(`Removed "${key}" (${removed.id}). Its repository is untouched.`);
}

/** Run one CLI invocation; returns the process exit code. */
export async function runCli(
  argv: string[],
  context: CliContext,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'add':
        await add(rest, context);
        return 0;
      case 'list':
        await list(rest, context);
        return 0;
      case 'remove':
        await remove(rest, context);
        return 0;
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        context.out(USAGE);
        return command === undefined ? 1 : 0;
      default:
        context.err(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof CliError || error instanceof RegistryError) {
      context.err(error.message);
      return 1;
    }
    // parseArgs reports unknown options this way.
    if (error instanceof TypeError && 'code' in error) {
      context.err(`${error.message}\n\n${USAGE}`);
      return 1;
    }
    throw error;
  }
}
