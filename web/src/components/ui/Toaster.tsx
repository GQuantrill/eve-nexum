import { useSyncExternalStore } from 'react';
import styles from './Toaster.module.css';
import { subscribe, getSnapshot, dismiss } from '../../utils/toastStore';

export function Toaster() {
  // useSyncExternalStore reads the current queue on subscribe, so a toast
  // emitted before this mounts (e.g. AppShell's on-load ?added / ?link_error
  // firing first in tree order) is picked up without a mount-effect sync.
  const toasts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (toasts.length === 0) return null;

  return (
    <div className={styles.toaster}>
      {toasts.map((t) => {
        const hasActions = !!t.actions?.length;
        // Plain toasts keep click-to-dismiss. Actionable/sticky toasts must not
        // dismiss on body click (you'd lose the buttons) — they get an explicit
        // close control instead.
        const dismissOnBodyClick = !hasActions && !t.sticky;
        return (
          <div
            key={t.id}
            className={[styles.toast, styles[t.kind], hasActions && styles.actionable].filter(Boolean).join(' ')}
            role={t.kind === 'error' ? 'alert' : 'status'}
            onClick={dismissOnBodyClick ? () => dismiss(t.id) : undefined}
            style={dismissOnBodyClick ? undefined : { cursor: 'default' }}
          >
            <div className={styles.body}>
              <span className={styles.msg}>{t.msg}</span>
              {(hasActions || t.sticky) && (
                <button
                  type="button"
                  className={styles.close}
                  aria-label="Dismiss"
                  onClick={() => dismiss(t.id)}
                >
                  ×
                </button>
              )}
            </div>
            {hasActions && (
              <div className={styles.actions}>
                {t.actions!.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    className={[styles.action, a.primary && styles.primary].filter(Boolean).join(' ')}
                    onClick={() => { a.onClick(); dismiss(t.id); }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
