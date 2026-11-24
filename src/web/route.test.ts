import { describe, expect, it } from 'vitest';
import { hrefFor, parseHash, trailFromState } from './route.ts';

describe('route', () => {
  it('parses a project, with or without a task', () => {
    expect(parseHash('#/alpha')).toEqual({ key: 'alpha', task: null });
    expect(parseHash('#/alpha/fix-it')).toEqual({
      key: 'alpha',
      task: 'fix-it',
    });
    expect(parseHash('#/_projects')).toEqual({ key: '_projects', task: null });
    expect(parseHash('')).toEqual({ key: null, task: null });
    expect(parseHash('#nope')).toEqual({ key: null, task: null });
  });

  it('round-trips slugs that need encoding', () => {
    const href = hrefFor('alpha', 'My_Task #2');
    expect(href).toBe('#/alpha/My_Task%20%232');
    expect(parseHash(href)).toEqual({ key: 'alpha', task: 'My_Task #2' });
    expect(hrefFor('alpha', null)).toBe('#/alpha');
  });

  it('reads back only the trail Radar wrote for that project and task', () => {
    const state = { radarProject: 'alpha', radarTask: 'b', trail: ['a'] };
    expect(trailFromState(state, 'alpha', 'b')).toEqual(['a']);
    expect(trailFromState(state, 'alpha', 'c')).toBeUndefined();
    expect(trailFromState(state, 'beta', 'b')).toBeUndefined();
    expect(trailFromState(null, 'alpha', 'b')).toBeUndefined();
  });
});
