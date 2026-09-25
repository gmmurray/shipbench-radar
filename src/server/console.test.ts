import { describe, expect, it } from 'vitest';
import { keyAction } from './console.ts';

describe('keyAction', () => {
  it('maps keys to actions, case-insensitively', () => {
    expect(keyAction('o')).toBe('open');
    expect(keyAction('O')).toBe('open');
    expect(keyAction('q')).toBe('quit');
    expect(keyAction('h')).toBe('help');
    expect(keyAction('?')).toBe('help');
  });

  it('quits on Ctrl+C and Ctrl+D, which raw mode delivers as keys', () => {
    expect(keyAction('\u0003')).toBe('quit');
    expect(keyAction('\u0004')).toBe('quit');
  });

  it('ignores everything else', () => {
    expect(keyAction('x')).toBe(null);
    expect(keyAction('\r')).toBe(null);
  });
});
