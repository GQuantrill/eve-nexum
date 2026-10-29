import { describe, it, expect } from 'vitest';
import { snapshotHour, nextPollDelay } from './activity.js';

const at = (iso: string) => Date.parse(iso);

// CCP cuts the hourly jumps/kills snapshot on its own cycle (seen live:
// Last-Modified 09:15:15, Expires 10:15:15), not on the hour.
describe('snapshotHour', () => {
  it('files a snapshot cut at 09:15 under 08:00, the hour most of it covers', () => {
    expect(snapshotHour(at('2026-10-29T09:15:15Z'))).toBe(at('2026-10-29T08:00:00Z'));
  });

  it('files one cut late in the hour under that same hour', () => {
    // 08:50-09:50 is mostly 09:xx.
    expect(snapshotHour(at('2026-10-29T09:50:00Z'))).toBe(at('2026-10-29T09:00:00Z'));
  });

  it('gives consecutive cuts consecutive hours, so none collide or go missing', () => {
    const cuts = ['09:15:15', '10:15:20', '11:15:09'].map((t) => snapshotHour(at(`2026-10-29T${t}Z`)));
    expect(cuts[1] - cuts[0]).toBe(3_600_000);
    expect(cuts[2] - cuts[1]).toBe(3_600_000);
  });
});

describe('nextPollDelay', () => {
  const now = at('2026-10-29T10:09:06Z');

  it('polls just after the next snapshot is due', () => {
    // Expires 10:15:15 -> about six minutes, plus the margin.
    expect(nextPollDelay(at('2026-10-29T10:15:15Z'), now)).toBe(6 * 60_000 + 9_000 + 30_000);
  });

  it('retries in a minute when CCP is late and Expires has passed', () => {
    expect(nextPollDelay(at('2026-10-29T10:00:00Z'), now)).toBe(60_000);
  });

  it('never waits longer than a little over an hour', () => {
    expect(nextPollDelay(at('2026-10-29T14:00:00Z'), now)).toBe(65 * 60_000);
  });

  it('retries in five minutes when there is no snapshot yet', () => {
    expect(nextPollDelay(null, now)).toBe(5 * 60_000);
  });
});
