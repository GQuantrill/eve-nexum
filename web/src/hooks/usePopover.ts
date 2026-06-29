import { useCallback, useEffect, useRef, useState } from 'react';

export interface PopoverPos {
  left:       number;
  top:        number;  // always placed below the trigger
  maxHeight:  number;  // available height below so the list stays on-screen + scrollable
}

// Nearest scrollable ancestor — the panel/pane the trigger lives in. Used to
// close the dropdown once the trigger scrolls out of that container, so a fixed-
// position dropdown never trails the (now-clipped) trigger out over the map.
function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let p = el?.parentElement ?? null;
  while (p) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight) return p;
    p = p.parentElement;
  }
  return null;
}

// Shared popover plumbing for the wormhole / leads-to dropdowns. Owns the
// open/close state, a viewport-aware position (always opens downward, follows
// page scroll, and caps its height to the room below so the last options stay
// reachable), and the outside-click handler — leaves the button look and
// dropdown contents to the caller.
export function usePopover() {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState<PopoverPos>({ left: 0, top: 0, maxHeight: 300 });
  const btnRef      = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);

  // Recompute from the trigger's current viewport rect. Always open downward
  // (flipping up read as odd); cap the height to the room below so the dropdown
  // never runs off-screen — the list scrolls within whatever height is left.
  const reposition = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    // If the trigger has scrolled out of its panel/pane (clipped invisible),
    // close rather than trail the fixed-position dropdown out over the map.
    const sp = scrollParentRef.current;
    if (sp) {
      const b = sp.getBoundingClientRect();
      if (rect.bottom <= b.top || rect.top >= b.bottom) { setOpen(false); return; }
    }
    const margin = 8;
    const top = rect.bottom + 2;
    const spaceBelow = Math.max(0, window.innerHeight - top - margin);
    setPos({ left: rect.left, top, maxHeight: spaceBelow });
  }, []);

  const openAt = useCallback(() => {
    scrollParentRef.current = scrollParentOf(btnRef.current);
    reposition();
    setOpen(true);
  }, [reposition]);

  // While open, keep the dropdown glued to the trigger as the page (or any
  // scroll container) scrolls or the window resizes. Capture phase so scrolls
  // inside nested containers are caught too.
  useEffect(() => {
    if (!open) return;
    reposition();
    const onMove = () => reposition();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    // Capture phase so the dropdown closes on a pointer-down ANYWHERE — including
    // the map canvas, which stops pointer-event propagation in the bubble phase
    // (a plain bubbling listener never fired for clicks out there). The target
    // check above keeps clicks inside the button/dropdown from closing it.
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, [open]);

  return { open, setOpen, pos, btnRef, dropdownRef, openAt };
}
