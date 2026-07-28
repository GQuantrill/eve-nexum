import { useEffect, useRef, type RefObject } from 'react';

// Call `onOutside` when a pointer-down lands outside `ref` (e.g. to close a
// menu/dropdown). No-op while `enabled` is false.
//
// Uses the CAPTURE phase + `pointerdown` deliberately: the react-flow map canvas
// stops pointer-event propagation in the bubble phase, so a plain bubbling
// listener never fires for clicks on the map — menus would stay open until you
// clicked their own trigger. Capturing at the document means "click anywhere
// outside" reliably closes, including on the map. Keep the menu's trigger button
// inside `ref` so its own click toggles rather than triggering an outside-close.
export function useClickOutside<T extends HTMLElement>(
  enabled: boolean,
  ref: RefObject<T | null>,
  onOutside: () => void,
) {
  // Keep the latest callback without re-subscribing the listener every render.
  // Written in an effect, not during render — refs are write-after-commit.
  const cb = useRef(onOutside);
  useEffect(() => { cb.current = onOutside; });

  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // A themed <Select>'s dropdown is portalled to <body>, so it's outside
      // `ref` — but a click on one of its options is NOT an "outside" click for
      // the popover that hosts the Select. Ignore it, or the host would close
      // (unmounting the Select) before the option's mousedown applies.
      if ((e.target as Element | null)?.closest?.('[data-select-dropdown]')) return;
      cb.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [enabled, ref]);
}
