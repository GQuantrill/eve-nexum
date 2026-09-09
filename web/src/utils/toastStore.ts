// Tiny event-driven toaster store. Module-level emitter so any call site can do
// `toast.error('...')` without threading context through props; the Toaster
// component (Toaster.tsx) subscribes to it at the app root.
//
// Split out from the component so that file exports only a component and Fast
// Refresh keeps working for both.

// Tiny event-driven toaster. Module-level emitter so any call site can do
// `toast.error('...')` without threading context through props. The Toaster
// component subscribes once at the app root and renders the live list.

export type ToastKind = 'error' | 'info' | 'success';

export interface ToastAction {
  label:    string;
  onClick:  () => void;
  /** Highlighted (filled) button — use for the default/confirm action. */
  primary?: boolean;
}

interface ToastOptions {
  kind?:      ToastKind;
  /** Auto-dismiss delay; ignored when `sticky`. */
  ttlMs?:     number;
  /** Buttons rendered in the toast. A click runs onClick then dismisses. */
  actions?:   ToastAction[];
  /** Never auto-dismiss — stays until an action or the close button is used.
      Use for a pending decision (e.g. the wormhole jump-confirm prompt). */
  sticky?:    boolean;
  /** If a live toast already shares this key, the new one is dropped. Lets
      callers raise an idempotent prompt without re-toasting on re-render. */
  dedupeKey?: string;
}

interface Toast {
  id:         number;
  kind:       ToastKind;
  msg:        string;
  actions?:   ToastAction[];
  sticky?:    boolean;
  dedupeKey?: string;
}

const subscribers = new Set<() => void>();
let current: Toast[] = [];
let nextId = 1;

function notify() {
  subscribers.forEach((fn) => fn());
}

// useSyncExternalStore plumbing. `current` is reassigned to a NEW array on every
// change (see show/dismiss), so getSnapshot's reference identity tracks changes
// and stays stable in between.
export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}
export function getSnapshot(): Toast[] {
  return current;
}

export function dismiss(id: number) {
  current = current.filter((t) => t.id !== id);
  notify();
}

// Returns the toast id (or -1 if dropped as a dedupe). Sticky toasts never
// schedule an auto-dismiss; the caller dismisses via an action/close.
function show(msg: string, opts: ToastOptions = {}): number {
  const { kind = 'info', actions, sticky = false, dedupeKey } = opts;
  if (dedupeKey && current.some((t) => t.dedupeKey === dedupeKey)) return -1;
  const id = nextId++;
  current = [...current, { id, kind, msg, actions, sticky, dedupeKey }];
  notify();
  if (!sticky) {
    setTimeout(() => dismiss(id), opts.ttlMs ?? 5000);
  }
  return id;
}

export const toast = {
  error:   (msg: string) => show(msg, { kind: 'error',   ttlMs: 7000 }),
  info:    (msg: string) => show(msg, { kind: 'info',    ttlMs: 4000 }),
  success: (msg: string) => show(msg, { kind: 'success', ttlMs: 3000 }),
  // Rich entry point: actions + sticky + dedupe. Built on the same emitter.
  show,
  dismiss,
};
