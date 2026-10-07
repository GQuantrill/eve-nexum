import { describe, it, expect } from 'vitest';
import {
  clampColumnCount, columnOf, bucketIntoColumns, movePane, reorderWithinColumn, normaliseWeights, resizeWeights } from './panelColumns';

const ORDER = ['activity', 'killboard', 'notes', 'signatures', 'anomalies'];

describe('column count', () => {
  it('defaults to one column, which is the layout that shipped', () => {
    // Anything unparseable must not silently split someone's panel.
    for (const v of [undefined, null, 'two', NaN, {}]) expect(clampColumnCount(v)).toBe(1);
  });

  it('clamps to the supported range', () => {
    expect(clampColumnCount(0)).toBe(1);
    expect(clampColumnCount(-5)).toBe(1);
    expect(clampColumnCount(3)).toBe(3);
    expect(clampColumnCount(9)).toBe(3);
  });
});

describe('column assignment', () => {
  it('puts a pane with no assignment in the first column', () => {
    // A pane added in a later release has no entry, and must appear somewhere
    // obvious rather than nowhere at all.
    expect(columnOf('brandNewPane', {}, 3)).toBe(0);
  });

  it('ignores a malformed assignment rather than trusting it', () => {
    for (const bad of [{ notes: -1 }, { notes: NaN }, { notes: 1.5 } as never]) {
      expect(columnOf('notes', bad as Record<string, number>, 3)).toBeLessThan(3);
    }
    expect(columnOf('notes', { notes: 'x' } as never, 3)).toBe(0);
  });

  it('folds a pane back into view when the column count drops', () => {
    // The important one: reducing 3 -> 2 must not strand a pane in a column
    // that no longer renders.
    expect(columnOf('notes', { notes: 2 }, 3)).toBe(2);
    expect(columnOf('notes', { notes: 2 }, 2)).toBe(1);
    expect(columnOf('notes', { notes: 2 }, 1)).toBe(0);
  });
});

describe('bucketing', () => {
  it('keeps every pane, and keeps each column in panelOrder order', () => {
    const cols = bucketIntoColumns(ORDER, { notes: 1, anomalies: 1 }, 2);
    expect(cols).toEqual([
      ['activity', 'killboard', 'signatures'],
      ['notes', 'anomalies'],
    ]);
    expect(cols.flat().sort()).toEqual([...ORDER].sort());   // nothing lost
  });

  it('still returns an entry for an empty column', () => {
    // The bucketing keeps empty columns so the arrows know how many there are.
    // The RENDER skips them: every column takes an equal share of the width, so
    // an empty one would show as a block of dead space -- a third of the panel,
    // with three columns and panes in two.
    expect(bucketIntoColumns(ORDER, {}, 3)).toEqual([ORDER, [], []]);
  });

  it('loses nothing when the count shrinks under the assignments', () => {
    const cols = bucketIntoColumns(ORDER, { notes: 2, anomalies: 2, signatures: 1 }, 2);
    expect(cols.flat().sort()).toEqual([...ORDER].sort());
  });
});

describe('moving a pane', () => {
  it('moves it and clamps to the available columns', () => {
    expect(movePane({}, 'notes', 1, 2)).toEqual({ notes: 1 });
    expect(movePane({}, 'notes', 5, 2)).toEqual({ notes: 1 });
    expect(movePane({}, 'notes', -3, 2)).toEqual({ notes: 0 });
  });

  it('leaves the other assignments alone', () => {
    expect(movePane({ killboard: 1 }, 'notes', 1, 2)).toEqual({ killboard: 1, notes: 1 });
  });
});

describe('reordering within a column', () => {
  it('reorders the dragged column without disturbing the others', () => {
    // activity/signatures are column 0; killboard/notes/anomalies column 1.
    const col0 = ['activity', 'signatures'];
    const next = reorderWithinColumn(ORDER, col0, 'signatures', 'activity');
    // Column 0's two panes swap, reusing their original slots...
    expect(next).toEqual(['signatures', 'killboard', 'notes', 'activity', 'anomalies']);
    // ...and the other column's panes keep their relative order exactly.
    const others = next.filter((id) => !col0.includes(id));
    expect(others).toEqual(['killboard', 'notes', 'anomalies']);
  });

  it('is a no-op for a drag that lands on itself or on an unknown id', () => {
    const col = ['activity', 'signatures'];
    expect(reorderWithinColumn(ORDER, col, 'activity', 'activity')).toBe(ORDER);
    expect(reorderWithinColumn(ORDER, col, 'activity', 'notAHere')).toBe(ORDER);
  });

  it('never changes which panes exist', () => {
    const col = ['killboard', 'notes', 'anomalies'];
    const next = reorderWithinColumn(ORDER, col, 'anomalies', 'killboard');
    expect([...next].sort()).toEqual([...ORDER].sort());
    expect(next).toHaveLength(ORDER.length);
  });
});

describe('normaliseWeights', () => {
  it('defaults to equal weights when nothing is stored', () => {
    expect(normaliseWeights(undefined, 3)).toEqual([1, 1, 1]);
    expect(normaliseWeights([], 2)).toEqual([1, 1]);
  });

  it('pads and truncates to the current column count', () => {
    expect(normaliseWeights([2], 3)).toEqual([2, 1, 1]);
    expect(normaliseWeights([2, 3, 4], 2)).toEqual([2, 3]);
  });

  it('replaces values that would collapse a column', () => {
    // A zero or NaN weight leaves a column with no width and no handle to
    // drag it back, so it must never survive.
    expect(normaliseWeights([0, -1, NaN], 3)).toEqual([1, 1, 1]);
    expect(normaliseWeights(['2', null, Infinity], 3)).toEqual([1, 1, 1]);
  });
});

describe('resizeWeights', () => {
  it('moves width from one column to its neighbour', () => {
    const next = resizeWeights([1, 1], 0, 1, 100, 1000);
    expect(next[0]).toBeGreaterThan(1);
    expect(next[1]).toBeLessThan(1);
  });

  it('keeps the pair total constant, so other columns do not move', () => {
    const next = resizeWeights([1, 1, 1], 0, 1, 150, 800);
    expect(next[0] + next[1]).toBeCloseTo(2);
    expect(next[2]).toBe(1);          // untouched
  });

  it('refuses to drag a column away to nothing', () => {
    const far = resizeWeights([1, 1], 0, 1, -99999, 1000);
    expect(far[0]).toBeGreaterThan(0);
    expect(far[0] / (far[0] + far[1])).toBeCloseTo(0.15);
  });

  it('leaves the weights alone when the geometry is unusable', () => {
    const w = [1, 1];
    expect(resizeWeights(w, 0, 1, 50, 0)).toBe(w);      // pre-paint, zero width
    expect(resizeWeights(w, 0, 1, NaN, 500)).toBe(w);
    expect(resizeWeights(w, 1, 2, 50, 500)).toBe(w);    // no column to the right
  });

  it('resizes across a skipped empty column', () => {
    // Column 1 is empty and unrendered, so the handle sits between 0 and 2.
    const next = resizeWeights([1, 1, 1], 0, 2, 120, 900);
    expect(next[0]).toBeGreaterThan(1);
    expect(next[2]).toBeLessThan(1);
    expect(next[1]).toBe(1);          // the skipped column is untouched
  });
});
