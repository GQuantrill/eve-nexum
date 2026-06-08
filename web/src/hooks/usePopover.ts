import { useEffect, useRef, useState } from 'react';

// Shared popover plumbing for the wormhole / leads-to dropdowns. Owns the
// open/close state, the screen-anchored position calculation, and the outside-
// click handler — leaves the button look and dropdown contents to the caller.
export function usePopover() {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef      = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const openAt = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 2, left: rect.left });
    setOpen(true);
  };

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
