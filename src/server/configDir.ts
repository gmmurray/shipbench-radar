import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Radar's config directory. `RADAR_HOME` wins (tests use it); otherwise
 * `%APPDATA%\radar` on Windows and `$XDG_CONFIG_HOME/radar` (falling back to
 * `~/.config/radar`) elsewhere. Deliberately never `~/.shipbench/` — see
 * DESIGN.md, "The project registry".
 */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (env.RADAR_HOME) return env.RADAR_HOME;
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'radar');
  }
  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'radar');
}

export function registryPathIn(configDir: string): string {
  return join(configDir, 'registry.json');
}
