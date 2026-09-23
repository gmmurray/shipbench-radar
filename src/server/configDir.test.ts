import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfigDir } from './configDir.ts';

describe('resolveConfigDir', () => {
  it('prefers RADAR_HOME everywhere', () => {
    expect(resolveConfigDir({ RADAR_HOME: '/custom' }, 'win32', '/home')).toBe(
      '/custom',
    );
  });

  it('uses APPDATA on Windows', () => {
    expect(
      resolveConfigDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32'),
    ).toBe(join('C:\\Users\\me\\AppData\\Roaming', 'radar'));
  });

  it('uses XDG_CONFIG_HOME, then ~/.config, elsewhere', () => {
    expect(
      resolveConfigDir({ XDG_CONFIG_HOME: '/xdg' }, 'linux', '/home'),
    ).toBe(join('/xdg', 'radar'));
    expect(resolveConfigDir({}, 'linux', '/home')).toBe(
      join('/home', '.config', 'radar'),
    );
  });
});
