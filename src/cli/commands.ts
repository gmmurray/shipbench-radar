import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inspectProject, openProject } from '../server/projects.ts';
import {
  planAddition,
  planRepair,
  RegistrationError,
} from '../server/registration.ts';
import {
  hiddenKeys,
  inTabOrder,
  loadRegistry,
  RegistryError,
} from '../server/registry.ts';
import {
  addRegistryEntry,
  removeRegistryEntry,
  setProjectHidden,
  setRegistryEntryPath,
} from '../server/registryFile.ts';

// `pnpm radar <command>`: explicit registration (DESIGN.md, "v1 plan" › M3).
// The rules live in registration.ts, shared with the Projects page. A running
// Radar watches registry.json, so every change here reaches it without a
// restart.

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
  move <key> <path>
      Point a project at its new location after the repository moved. A
      GitHub identity must match the new checkout's origin.
  list
      Show every registered project, in tab order, whether it is
      available, and whether its tab is hidden.
  show <key> | hide <key>
      Show or hide a project's tab. A hidden project stays registered and
      watched, and reopens from the tab bar's Projects menu.
  remove <key>
      Unregister a project. Its repository is not touched.`;

/** Thrown for a user-facing failure; its message is the whole report. */
class CliError extends Error {}

/** A shared-rule refusal, plus the flag that fixes it. */
function cliMessage(error: RegistrationError): string {
  switch (error.field) {
    case 'id': {
      const example = error.example ? `, e.g. --id ${error.example}` : '';
      return `${error.message}\nPass one with --id${example}.`;
    }
    case 'key':
      return `${error.message}\nPick another with --key.`;
    default:
      return error.message;
  }
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

  const registry = await loadRegistry(context.registryPath);
  const entry = await planAddition(
    {
      path: resolve(context.cwd, positionals[0]!),
      key: values.key,
      id: values.id,
    },
    registry,
  );
  await addRegistryEntry(context.registryPath, entry);
  context.out(`Added "${entry.key}": ${entry.id}`);
  context.out(`  ${entry.path}`);
  context.out(`Registry: ${context.registryPath}`);
}

async function move(args: string[], context: CliContext): Promise<void> {
  if (args.length !== 2) {
    throw new CliError(`move takes a key and a path.\n\n${USAGE}`);
  }
  const [key, target] = args as [string, string];
  const registry = await loadRegistry(context.registryPath);
  const entry = await planRepair(key, resolve(context.cwd, target), registry);
  await setRegistryEntryPath(context.registryPath, key, entry.path);
  context.out(`Moved "${key}" (${entry.id}) to ${entry.path}`);
}

async function list(args: string[], context: CliContext): Promise<void> {
  if (args.length > 0) {
    throw new CliError(`list takes no arguments.\n\n${USAGE}`);
  }

  const registry = await loadRegistry(context.registryPath);
  context.out(`Registry: ${context.registryPath}`);
  if (registry.projects.length === 0) {
    context.out('No projects registered. Add one with: pnpm radar add <path>');
    return;
  }

  const entries = inTabOrder(registry);
  const hidden = hiddenKeys(registry);
  const width = Math.max(...entries.map(p => p.key.length));
  for (const entry of entries) {
    const status = await inspectProject(openProject(entry));
    const mark = status.available ? 'ok     ' : 'missing';
    const tab = hidden.has(entry.key) ? '  (hidden)' : '';
    context.out(`  ${entry.key.padEnd(width)}  ${mark}  ${entry.id}${tab}`);
    context.out(`  ${' '.repeat(width)}           ${entry.path}`);
    if (!status.available) {
      context.out(`  ${' '.repeat(width)}           ${status.reason}`);
    }
  }
}

async function remove(args: string[], context: CliContext): Promise<void> {
  if (args.length !== 1) {
    throw new CliError(`remove takes one key.\n\n${USAGE}`);
  }
  const key = args[0]!;

  const removed = await removeRegistryEntry(context.registryPath, key);
  if (!removed) {
    const registry = await loadRegistry(context.registryPath);
    const keys = registry.projects.map(p => p.key).join(', ') || 'none';
    throw new CliError(`No project "${key}". Registered keys: ${keys}.`);
  }
  context.out(`Removed "${key}" (${removed.id}). Its repository is untouched.`);
}

async function setHidden(
  args: string[],
  context: CliContext,
  hidden: boolean,
): Promise<void> {
  const command = hidden ? 'hide' : 'show';
  if (args.length !== 1) {
    throw new CliError(`${command} takes one key.\n\n${USAGE}`);
  }
  const key = args[0]!;
  if (!(await setProjectHidden(context.registryPath, key, hidden))) {
    const registry = await loadRegistry(context.registryPath);
    const keys = registry.projects.map(p => p.key).join(', ') || 'none';
    throw new CliError(`No project "${key}". Registered keys: ${keys}.`);
  }
  context.out(
    hidden
      ? `Hid "${key}". It stays registered; reopen it from the Projects menu or with: pnpm radar show ${key}`
      : `Showing "${key}" in the tab bar.`,
  );
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
      case 'move':
        await move(rest, context);
        return 0;
      case 'list':
        await list(rest, context);
        return 0;
      case 'remove':
        await remove(rest, context);
        return 0;
      case 'show':
      case 'hide':
        await setHidden(rest, context, command === 'hide');
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
    if (error instanceof RegistrationError) {
      context.err(cliMessage(error));
      return 1;
    }
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
