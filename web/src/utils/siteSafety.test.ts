import { describe, it, expect } from 'vitest';
import { siteSafety } from './siteSafety';

const sig = (name: string, sigType = 'data') => ({ sigType, name } as never);

describe('siteSafety', () => {
  it('marks the confirmed event data sites safe', () => {
    for (const n of [
      'Crimson Harvest Network Node', 'Crimson Harvest Network Hub',
      'Tetrimon Network Node', 'Tetrimon Network Hub',
      'Wightstorm Comms Relay', 'Wightstorm Strategic Node', 'Wightstorm Crypto Facility',
    ]) {
      expect(siteSafety(sig(n))).toBe('safe');
    }
  });

  it('does not vouch for other sites from the same events', () => {
    // The whole point of matching full names: sharing a first word with a
    // confirmed site is not evidence about this one.
    expect(siteSafety(sig('Crimson Harvest Covert Base'))).toBeNull();
    expect(siteSafety(sig('Wightstorm Forward Camp'))).toBeNull();
  });

  it('still applies the standard prefix rules', () => {
    expect(siteSafety(sig('Ruined Sansha Monument Site'))).toBe('safe');
    expect(siteSafety(sig('Forgotten Sansha Excavation'))).toBe('unsafe');
    expect(siteSafety(sig('Detected Central Angel Data'))).toBe('safe');
  });

  it('only judges relic and data signatures', () => {
    expect(siteSafety(sig('Crimson Harvest Network Node', 'combat'))).toBeNull();
    expect(siteSafety(sig('Crimson Harvest Network Node', 'relic'))).toBe('safe');
  });

  it('is case- and spacing-insensitive, and ignores a Detected prefix', () => {
    expect(siteSafety(sig('  crimson   harvest   network   node '))).toBe('safe');
    expect(siteSafety(sig('Detected Tetrimon Network Hub'))).toBe('safe');
  });

  it('says nothing about an empty or unknown name', () => {
    expect(siteSafety(sig(''))).toBeNull();
    expect(siteSafety(sig('Some Unlisted Site'))).toBeNull();
  });
});
