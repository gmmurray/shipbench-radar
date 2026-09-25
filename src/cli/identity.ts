import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import { parseGithubRemoteUrl } from '@shipbench/core';
import { KEY_PATTERN } from '../server/registry.ts';

const run = promisify(execFile);

/** The `origin` remote's URL, or null if there is no repo or no origin. */
export async function readOriginUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { windowsHide: true },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export interface GithubIdentity {
  /** `github.com/<owner>/<repo>`, lowercased: GitHub names are case-blind. */
  id: string;
  repo: string;
}

export function githubIdentity(remoteUrl: string): GithubIdentity | null {
  const parts = parseGithubRemoteUrl(remoteUrl);
  if (!parts) return null;
  return {
    id: `github.com/${parts.owner}/${parts.repo}`.toLowerCase(),
    repo: parts.repo,
  };
}

/**
 * A key suggested from a repository or directory name: lowercased, with runs
 * of anything outside [a-z0-9] collapsed to a hyphen. Null when nothing
 * usable is left.
 */
export function suggestKey(name: string): string | null {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return KEY_PATTERN.test(key) ? key : null;
}

export function directoryName(path: string): string {
  return basename(path);
}
