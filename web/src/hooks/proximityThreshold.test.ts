import { describe, it, expect } from 'vitest';
import { writeThreshold, readThreshold, MAX_THRESHOLD } from './useProximityAlerts';

describe('proximity alert range', () => {
  it('keeps any range up to the maximum, and caps beyond it', () => {
    writeThreshold(8);
    expect(readThreshold()).toBe(8);
    writeThreshold(MAX_THRESHOLD);
    expect(readThreshold()).toBe(10);
    writeThreshold(40);
    expect(readThreshold()).toBe(10);
  });
});
