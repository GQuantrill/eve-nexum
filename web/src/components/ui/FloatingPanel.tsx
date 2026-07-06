import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowSquareInIcon } from '@phosphor-icons/react';

export interface PanelGeometry { x: number; y: number; w: number; h: number; }

interface Props {
  title:      string;
  geometry:   PanelGeometry;
  /** Called on drag/resize end with the settled geometry (parent persists). */
  onCommit:   (g: PanelGeometry) => void;
  onRedock:   () => void;
  onFocus?:   () => void;
  zIndex?:    number;
  children:   ReactNode;
}

const MIN_W = 260;
const MIN_H = 140;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// A floating, draggable + resizable window hosting an undocked panel. Portals to
// document.body so it escapes the dock's overflow:hidden and sits above the
// canvas. Drag via the title bar, resize from the bottom-right corner — both use
// the pointer-capture idiom used elsewhere (Sidebar resize), and geometry is
// committed to the parent only on release to avoid re-rendering on every move.
export function FloatingPanel({ title, geometry, onCommit, onRedock, onFocus, zIndex, children }: Props) {
  const { t } = useTranslation();
  const [geo, setGeo] = useState<PanelGeometry>(geometry);
  const latest = useRef<PanelGeometry>(geo);
  const apply = (next: PanelGeometry) => { latest.current = next; setGeo(next); };

  const dragRef   = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ px: number; py: number; ow: number; oh: number } | null>(null);

  const onBarPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    onFocus?.();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, ox: latest.current.x, oy: latest.current.y };
  };
  const onBarPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const x = clamp(d.ox + (e.clientX - d.px), 0, window.innerWidth  - 80);
    const y = clamp(d.oy + (e.clientY - d.py), 0, window.innerHeight - 40);
    apply({ ...latest.current, x, y });
  };
  const endDrag = () => { if (dragRef.current) { dragRef.current = null; onCommit(latest.current); } };

  const onResizePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    onFocus?.();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resizeRef.current = { px: e.clientX, py: e.clientY, ow: latest.current.w, oh: latest.current.h };
  };
  const onResizePointerMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const w = Math.max(MIN_W, r.ow + (e.clientX - r.px));
    const h = Math.max(MIN_H, r.oh + (e.clientY - r.py));
    apply({ ...latest.current, w, h });
  };
  const endResize = () => { if (resizeRef.current) { resizeRef.current = null; onCommit(latest.current); } };

  return createPortal(
    <div
      className="floating-panel"
      style={{ left: geo.x, top: geo.y, width: geo.w, height: geo.h, zIndex }}
      onPointerDown={onFocus}
    >
      <div
        className="floating-panel__bar"
        onPointerDown={onBarPointerDown}
        onPointerMove={onBarPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="floating-panel__title">{title}</span>
        <button
          type="button"
          className="floating-panel__redock"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onRedock}
          title={t('panel.redock')}
          aria-label={t('panel.redock')}
        >
          <ArrowSquareInIcon size={14} weight="regular" />
        </button>
      </div>
      <div className="floating-panel__body">{children}</div>
      <div
        className="floating-panel__resize"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        aria-hidden="true"
      />
    </div>,
    document.body,
  );
}
