import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Global tooltip layer for every `[data-tooltip]` element in the app.
 *
 * The old approach was a pure-CSS `[data-tooltip]::after` pseudo-element
 * centred below (or, via manual `.tooltip-right` / `.tooltip-above` opt-in
 * classes, beside/above) the trigger. CSS can't measure the viewport, so a
 * wide tooltip on a trigger near a screen edge — e.g. the waypoint buttons in
 * a left-docked sidebar pane — would spill off-screen and get clipped.
 *
 * This mounts once at the app root and listens (via event delegation) for
 * hover/focus on anything carrying `data-tooltip`. It renders a single portal
 * chip positioned from the trigger's bounding rect and then CLAMPED inside the
 * viewport, so a tooltip can never leave the display area regardless of where
 * its trigger sits. The matching CSS hover-reveal is disabled so the two
 * mechanisms don't double up (see App.css `[data-tooltip]`).
 *
 * Placement honours the same opt-in hints the CSS variants used:
 *   - `.tooltip-right`  -> to the right of the trigger
 *   - `.tooltip-above`  -> above the trigger
 *   - (default)         -> below, auto-flipping above when there's no room
 * After placement the chip is clamped on both axes with a viewport margin.
 */

const MARGIN = 6; // keep at least this far from every viewport edge
const GAP = 6;     // distance between trigger and chip

type Placement = 'below' | 'above' | 'right';
type Trigger = { text: string; rect: DOMRect; placement: Placement };

export function TooltipLayer() {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const chipRef = useRef<HTMLDivElement>(null);

  // Delegate hover/focus tracking from the document so we cover every
  // `[data-tooltip]` in the tree — current and future — without per-element wiring.
  useEffect(() => {
    let active: Element | null = null;
    // When we show a custom chip for a plain `title`, we strip the title for the
    // duration of the hover so the browser's own (slow, ~0.5-1.5s) native
    // tooltip doesn't fire too. It's restored the moment the hover ends, so the
    // element's accessible name is intact at rest.
    let strippedTitle: string | null = null;

    // Trigger off both the app's `data-tooltip` markers and any native `title`,
    // so every titled control gets the instant, styled, viewport-clamped chip
    // instead of the browser's delayed one.
    const SEL = '[data-tooltip], [title]';

    const placementFor = (el: Element): Placement =>
      el.classList.contains('tooltip-right') ? 'right'
        : el.classList.contains('tooltip-above') ? 'above'
          : 'below';

    const restoreTitle = () => {
      if (active && strippedTitle != null) active.setAttribute('title', strippedTitle);
      strippedTitle = null;
    };

    // stripTitle is true for mouse hover (suppress the native tooltip) and false
    // for keyboard focus — no native tooltip fires on focus, and keeping `title`
    // preserves the accessible name while the control is focused.
    const open = (el: Element, stripTitle: boolean) => {
      restoreTitle(); // put back any title taken from a previous trigger
      let text = el.getAttribute('data-tooltip');
      if (!text) {
        const tt = el.getAttribute('title');
        if (!tt) return;
        text = tt;
        if (stripTitle) { strippedTitle = tt; el.removeAttribute('title'); }
      }
      active = el;
      setPos(null); // hide until measured at the new size
      setTrigger({ text, rect: el.getBoundingClientRect(), placement: placementFor(el) });
    };

    const close = () => {
      if (!active) return;
      restoreTitle();
      active = null;
      setTrigger(null);
      setPos(null);
    };

    const onOver = (e: Event) => {
      const target = e.target as Element | null;
      // Still inside the active trigger (whose `title` we may have stripped, so
      // it no longer matches SEL) — keep it open.
      if (active && target && active.contains(target)) return;
      const el = target?.closest?.(SEL) ?? null;
      if (el && el !== active) open(el, true);
      else if (!el && active) close();
    };
    const onOut = (e: MouseEvent) => {
      if (!active) return;
      const to = e.relatedTarget as Node | null;
      // Only dismiss once the pointer has actually left the active trigger.
      if (!to || !active.contains(to)) close();
    };
    const onFocusIn = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.(SEL) ?? null;
      if (el) open(el, false); else close();
    };

    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', close, true);
    // Any layout shift invalidates the cached trigger rect — just hide.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close, true);

    return () => {
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', close, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close, true);
    };
  }, []);

  // Once the chip is in the DOM at its natural size, position it from the
  // trigger rect and clamp inside the viewport.
  useLayoutEffect(() => {
    if (!trigger || !chipRef.current) return;
    const tip = chipRef.current.getBoundingClientRect();
    const { rect, placement } = trigger;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top: number;
    let left: number;
    if (placement === 'right') {
      top = rect.top + rect.height / 2 - tip.height / 2;
      left = rect.right + GAP;
    } else if (placement === 'above') {
      top = rect.top - GAP - tip.height;
      left = rect.left + rect.width / 2 - tip.width / 2;
    } else {
      top = rect.bottom + GAP;
      left = rect.left + rect.width / 2 - tip.width / 2;
      // Flip above when there isn't room below.
      if (top + tip.height > vh - MARGIN && rect.top - GAP - tip.height >= MARGIN) {
        top = rect.top - GAP - tip.height;
      }
    }

    left = Math.max(MARGIN, Math.min(left, vw - tip.width - MARGIN));
    top = Math.max(MARGIN, Math.min(top, vh - tip.height - MARGIN));
    setPos({ top, left });
  }, [trigger]);

  if (!trigger) return null;

  return createPortal(
    <div
      ref={chipRef}
      className="floating-tooltip floating-tooltip--auto"
      role="tooltip"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // Render offscreen-invisible for the measuring pass so the user never
        // sees an unclamped flash at the wrong position.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {trigger.text}
    </div>,
    document.body,
  );
}
