import type { ReactNode } from 'react';
import type { SigType } from '../../types';

// Signature group icons, drawn after the in-game probe scanner's so a pilot
// reads them the same at a glance. Our own SVGs rather than CCP's bitmaps: they
// stay sharp at any text size and take the row's type colour (currentColor), so
// they follow the colour-vision palette like the text labels do. Ghost and
// unknown have no scanner icon of their own and get shapes in the same style.

function hex(cx: number, cy: number, w: number, h: number): string {
  const x = w / 2, q = w / 4, y = h / 2;
  return [[cx - x, cy], [cx - q, cy - y], [cx + q, cy - y], [cx + x, cy], [cx + q, cy + y], [cx - q, cy + y]]
    .map(([a, b]) => `${a},${b}`).join(' ');
}

const BLADE = 'M11 12.5 Q9.6 5.4 17.4 2.4 Q14.6 6.8 15.4 12.2 Z';

const SHAPES: Record<SigType, ReactNode> = {
  combat: (
    <>
      <polygon points="7,8.5 12,3 17,8.5 12,6.8" fillOpacity={1} />
      <polygon points="3,10.5 12,16 21,10.5 12,21.5" />
    </>
  ),
  data: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" fill="none" />
      <path d="M8 7.5v9M12 7.5v9M16 7.5v9" fill="none" />
    </>
  ),
  gas: (
    <path d="M3.8 7.2C2.6 4.2 5.6 2.2 8.2 3.8L12 6L15.8 3.8C18.4 2.2 21.4 4.2 20.2 7.2C19.2 9.6 16 10.6 15.2 13C14.8 14.2 15.2 16 15.2 18C15.2 22 8.8 22 8.8 18C8.8 16 9.2 14.2 8.8 13C8 10.6 4.8 9.6 3.8 7.2Z" />
  ),
  ore: (
    <>
      <polygon points={hex(12, 7, 11, 6.4)} />
      <polygon points={hex(6.8, 16.6, 8.4, 5.2)} />
      <polygon points={hex(17.2, 16.6, 8.4, 5.2)} />
    </>
  ),
  relic: (
    <>
      <circle cx="12" cy="8.5" r="4.3" />
      <path d="M4.2 7.6C4.2 20.6 19.8 20.6 19.8 7.6" fill="none" />
      <circle cx="4.2" cy="6.6" r="1.6" fill="currentColor" fillOpacity={1} stroke="none" />
      <circle cx="19.8" cy="6.6" r="1.6" fill="currentColor" fillOpacity={1} stroke="none" />
    </>
  ),
  wormhole: (
    <>
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <path key={a} d={BLADE} transform={`rotate(${a} 12 12)`} />
      ))}
    </>
  ),
  ghost: (
    <>
      <path d="M6 20V10.5a6 6 0 0 1 12 0V20l-2-1.6-2 1.6-2-1.6-2 1.6-2-1.6Z" />
      <circle cx="9.8" cy="10.8" r="1.1" fill="currentColor" fillOpacity={1} stroke="none" />
      <circle cx="14.2" cy="10.8" r="1.1" fill="currentColor" fillOpacity={1} stroke="none" />
    </>
  ),
  unknown: (
    <>
      <circle cx="12" cy="12" r="8.5" fill="none" strokeDasharray="3 2.4" />
      <path d="M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2 1-1.2 1.8v.4" fill="none" />
      <circle cx="12" cy="16.6" r="1" fill="currentColor" fillOpacity={1} stroke="none" />
    </>
  ),
};

export function SigTypeIcon({ type, size = 16 }: { type: SigType; size?: number }) {
  return (
    <svg
      className="sig-type-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillOpacity={0.3}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinejoin="round"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {SHAPES[type]}
    </svg>
  );
}
