import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowSquareInIcon, XIcon } from '../../icons';

export interface PanelGeometry { x: number; y: number; w: number; h: number; }

interface Props {
  title:      string;
  geometry:   PanelGeometry;
  /** Called on drag/resize end with the settled geometry (parent persists). */
  onCommit:   (g: PanelGeometry) => void;
  onRedock:   () => void;
  /** When given, the bar also carries a close button. Panels that are only ever
   *  docked or floating (never dismissed) leave this off and show redock only. */
  onClose?:   () => void;
  /** Size the window's HEIGHT to its content instead of to `geometry.h`,
   *  clamped to what's left of the viewport below it. Width stays as set: a
   *  window that re-widened itself as you clicked between items would be far
   *  more jarring than one that gets shorter. Dragging the corner takes over
   *  and switches this off. */
  autoHeight?: boolean;
  /** Fired once when a resize gesture starts, so the owner can record that the
   *  pilot has taken manual control of the size. */
  onManualResize?: () => void;
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
export function FloatingPanel({
  title, geometry, onCommit, onRedock, onClose, autoHeight, onManualResize, onFocus, zIndex, children,
}: Props) {
  const { t } = useTranslation();
  const [geo, setGeo] = useState<PanelGeometry>(geometry);
  const latest = useRef<PanelGeometry>(geo);
  const apply = (next: PanelGeometry) => { latest.current = next; setGeo(next); };

  const dragRef   = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const resizeRef = useRef<{ px: number; py: number; ow: number; oh: number } | null>(null);
  const boxRef    = useRef<HTMLDivElement | null>(null);

  // Local latch so the switch to a fixed height happens on THIS frame. The
  // parent's autoHeight only flips after its state round-trips, and until it
  // did the window would keep auto-sizing and fight the drag.
  const [manualH, setManualH] = useState(false);
  const useAuto = !!autoHeight && !manualH;

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
    // While auto-sized the stored height is whatever it was last pinned to and
    // has nothing to do with what's on screen, so drag from the height the
    // window actually has or it jumps on the first pixel of movement.
    const rendered = boxRef.current?.getBoundingClientRect().height;
    if (useAuto) { setManualH(true); onManualResize?.(); }
    resizeRef.current = {
      px: e.clientX, py: e.clientY,
      ow: latest.current.w,
      oh: useAuto && rendered ? Math.round(rendered) : latest.current.h,
    };
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
      ref={boxRef}
      className="floating-panel"
      style={{
        left: geo.x, top: geo.y, width: geo.w, zIndex,
        // Auto-sized: let the content set the height, but never past the bottom
        // of the screen -- the body scrolls once it would.
        height:    useAuto ? 'auto' : geo.h,
        maxHeight: useAuto ? `calc(100vh - ${geo.y}px - 8px)` : undefined,
        // The 140px floor exists so a hand-dragged window can't become a
        // sliver. Auto-sizing has no such problem -- the content is the floor --
        // and leaving it on would re-introduce the empty space this is for.
        minHeight: useAuto ? 0 : undefined,
      }}
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
        {onClose && (
          <button
            type="button"
            className="floating-panel__close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onClose}
            title={t('actions.close')}
            aria-label={t('actions.close')}
          >
            <XIcon size={14} weight="bold" />
          </button>
        )}
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
