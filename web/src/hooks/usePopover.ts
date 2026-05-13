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
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!btnRef.current?.contains(target) && !dropdownRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return { open, setOpen, pos, btnRef, dropdownRef, openAt };
}
