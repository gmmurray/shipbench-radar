import { describe, expect, it } from 'vitest';
import { titleFor } from './title.ts';

describe('titleFor', () => {
  it('names the open view at rest', () => {
    expect(titleFor({ label: 'Alpha', unseen: 0, flash: null })).toBe(
      'Alpha | ShipBench Radar',
    );
    expect(titleFor({ label: null, unseen: 0, flash: null })).toBe(
      'ShipBench Radar',
    );
  });

  it('marks unseen changes with a dot, counting only past one', () => {
    expect(titleFor({ label: 'Alpha', unseen: 1, flash: null })).toBe(
      '● Alpha | ShipBench Radar',
    );
    expect(titleFor({ label: 'Alpha', unseen: 3, flash: null })).toBe(
      '● (3) Alpha | ShipBench Radar',
    );
  });

  it('announces a fresh change before settling', () => {
    expect(titleFor({ label: 'Alpha', unseen: 2, flash: 'Beta' })).toBe(
      '↻ Beta updated | ShipBench Radar',
    );
  });
});
