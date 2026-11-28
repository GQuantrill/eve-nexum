import { describe, expect, it } from 'vitest';
import { edgeTarget } from './columnResize';

const cols = ['id', 'type', 'name', 'notes', 'updated'] as const;

describe('edgeTarget', () => {
  it('left of the filler, the column itself grows with the pointer', () => {
    expect(edgeTarget(cols, 'name', 'id')).toEqual({ col: 'id', sign: 1 });
    expect(edgeTarget(cols, 'name', 'type')).toEqual({ col: 'type', sign: 1 });
  });

  it('from the filler rightwards, the next column resizes the other way', () => {
    expect(edgeTarget(cols, 'name', 'name')).toEqual({ col: 'notes', sign: -1 });
    expect(edgeTarget(cols, 'name', 'notes')).toEqual({ col: 'updated', sign: -1 });
  });

  it('the last column has no movable right edge', () => {
    expect(edgeTarget(cols, 'name', 'updated')).toBeNull();
  });

  it('with no filler every column resizes itself', () => {
    expect(edgeTarget(cols, null, 'updated')).toEqual({ col: 'updated', sign: 1 });
  });

  it('a column not in the list has no edge', () => {
    expect(edgeTarget(['id', 'name'], 'name', 'notes' as 'id')).toBeNull();
  });
});
