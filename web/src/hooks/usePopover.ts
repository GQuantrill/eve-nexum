import { useCallback, useEffect, useRef, useState } from 'react';

export interface PopoverPos {
  left:       number;
  top?:       number;  // set when placed below the trigger
  bottom?:    number;  // set when flipped above the trigger (anchors its bottom)
  maxHeight:  number;  // available height so the list stays on-screen + scrollable
}

// Shared popover plumbing for the wormhole / leads-to dropdowns. Owns the
// open/close state, a viewport-aware position (follows page scroll, flips above
// the trigger and caps its height so the last options stay reachable), and the
// outside-click handler — leaves the button look and dropdown contents to the
// caller.
export function usePopover() {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState<PopoverPos>({ left: 0, top: 0, maxHeight: 300 });
  const btnRef      = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Recompute from the trigger's current viewport rect: place below by default,
  // flip above when there's little room below and more above, and cap the height
  // to the available space so the dropdown never runs off-screen.
  const reposition = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const flipUp = spaceBelow < 220 && spaceAbove > spaceBelow;
    setPos(flipUp
      ? { left: rect.left, bottom: window.innerHeight - rect.top + 2, maxHeight: Math.max(140, spaceAbove) }
      : { left: rect.left, top: rect.bottom + 2,                      maxHeight: Math.max(140, spaceBelow) });
  }, []);

  const openAt = useCallback(() => { reposition(); setOpen(true); }, [reposition]);

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
