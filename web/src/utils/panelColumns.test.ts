import { describe, it, expect } from 'vitest';
import {
  clampColumnCount, columnOf, bucketIntoColumns, movePane, reorderWithinColumn,
} from './panelColumns';

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

  it('gives every column an entry even when empty, so it stays a drop target', () => {
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
