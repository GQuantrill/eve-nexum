import { useEffect, useRef } from 'react';

// Escape closes the window, dialog or popover on top -- only that one, so a
// confirm opened over the jump planner closes on its own and the planner stays.
// One listener for all of them, keeping a stack in open order.
//
// A control that uses Escape itself first (an open Select list, a combobox's
// results) calls preventDefault or stopPropagation, and this leaves the key to
// it.

type Entry = { close: () => void };
const stack: Entry[] = [];

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  top.close();
}

export function useEscapeClose(onClose: () => void, active = true): void {
  // Latest onClose without re-registering (which would move it up the stack).
  const latest = useRef(onClose);
  useEffect(() => { latest.current = onClose; });

  useEffect(() => {
    if (!active) return;
    const entry: Entry = { close: () => latest.current() };
    if (stack.length === 0) window.addEventListener('keydown', onKey);
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      if (stack.length === 0) window.removeEventListener('keydown', onKey);
    };
  }, [active]);
}
