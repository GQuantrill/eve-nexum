// Width of the docked panel column in the side-by-side layout. Shared by the
// system and connection panels, which take the same slot (selecting one closes
// the other), so the map doesn't change width as you click between them.
//
// Column mode keeps its own size. Sharing one number with row mode means
// switching layouts hands you a 300px-wide panel because that was your height.
export const SIDE_KEY = 'nexum.panelSideWidth';
const DEFAULT_SW = 460;
const MIN_SW     = 320;

export function clampSide(v: number): number {
  return Math.min(Math.floor(window.innerWidth * 0.7), Math.max(MIN_SW, v));
}

/** The saved column width, clamped to the current window. */
export function readSideWidth(): number {
  const v = localStorage.getItem(SIDE_KEY);
  return v ? clampSide(parseInt(v, 10)) : DEFAULT_SW;
}
