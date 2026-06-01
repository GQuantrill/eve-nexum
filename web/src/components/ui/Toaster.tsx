import { useEffect, useState } from 'react';

// Tiny event-driven toaster. Module-level emitter so any call site can do
// `toast.error('...')` without threading context through props. The Toaster
// component subscribes once at the app root and renders the live list.

export type ToastKind = 'error' | 'info' | 'success';

interface Toast {
  id:   number;
  kind: ToastKind;
  msg:  string;
}

const subscribers = new Set<(toasts: Toast[]) => void>();
let current: Toast[] = [];
let nextId = 1;

function notify() {
  subscribers.forEach((fn) => fn(current));
}

function push(kind: ToastKind, msg: string, ttlMs = 5000) {
  const id = nextId++;
  current = [...current, { id, kind, msg }];
  notify();
  setTimeout(() => {
    current = current.filter((t) => t.id !== id);
    notify();
  }, ttlMs);
}

export const toast = {
  error:   (msg: string) => push('error',   msg, 7000),
  info:    (msg: string) => push('info',    msg, 4000),
  success: (msg: string) => push('success', msg, 3000),
};

export function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>(current);

  useEffect(() => {
    subscribers.add(setToasts);
    // Sync immediately in case a toast was emitted before this subscribe ran
    // — e.g. AppShell's on-load ?added / ?link_error effect fires before the
    // Toaster's effect (tree order), so without this the queued toast is lost.
    setToasts(current);
    return () => { subscribers.delete(setToasts); };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toaster">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
          onClick={() => { current = current.filter((c) => c.id !== t.id); notify(); }}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
