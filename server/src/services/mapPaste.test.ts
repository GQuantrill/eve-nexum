import { describe, it, expect } from 'vitest';
import { pasteOffset, placeClear } from './mapPaste.js';

describe('where pasted systems go', () => {
  it('lines up on the first system the map already has', () => {
    expect(pasteOffset([{ x: 0, y: 0 }], [{ sx: 100, sy: 50, dx: 600, dy: 450 }], [], { x: 9, y: 9 }))
      .toEqual({ x: 500, y: 400 });
  });

  it('else centres on the anchor, else goes right of the map', () => {
    const group = [{ x: 0, y: 0 }, { x: 200, y: 100 }];
    expect(pasteOffset(group, [], [{ x: 0, y: 0 }], { x: 1000, y: 1000 })).toEqual({ x: 900, y: 950 });
    expect(pasteOffset(group, [], [{ x: 100, y: 40 }], null)).toEqual({ x: 460, y: 40 });
  });

  it('pushes new systems clear of the map without moving the map', () => {
    const fixed = [{ x: 0, y: 0 }];
    const moving = [{ x: 10, y: 0 }, { x: 20, y: 0 }];
    placeClear(moving, fixed);
    expect(fixed).toEqual([{ x: 0, y: 0 }]);
    for (const m of moving) expect(Math.abs(m.x) >= 240 || Math.abs(m.y) >= 160).toBe(true);
    const [p, q] = moving;
    expect(Math.abs(p.x - q.x) >= 240 || Math.abs(p.y - q.y) >= 160).toBe(true);
  });
});
