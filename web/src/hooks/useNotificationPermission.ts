import { useEffect, useState } from 'react';

// Browser notification permission, kept reactive across the app. Two paths
// keep subscribers in sync:
//  1. The Permissions API's `onchange` event (when supported) catches changes
//     made outside our UI — e.g. via the browser's site settings.
//  2. `notifyPermissionChanged()` is called by the in-app opt-in modal after
//     `Notification.requestPermission()` resolves, so other components (the
//     Map Options sidebar) flip from "Enable" to "Enabled" immediately.

function read(): NotificationPermission {
  return typeof Notification === 'undefined' ? 'denied' : Notification.permission;
}

const subscribers = new Set<(p: NotificationPermission) => void>();

export function notifyPermissionChanged() {
  const p = read();
  subscribers.forEach((fn) => fn(p));
}

export function useNotificationPermission(): NotificationPermission {
  const [perm, setPerm] = useState<NotificationPermission>(read);

  useEffect(() => {
    subscribers.add(setPerm);
    // Deliberate: seeds from the live permission value on subscribe.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPerm(read());

    let teardown: (() => void) | null = null;
    if (typeof navigator !== 'undefined' && 'permissions' in navigator) {
      navigator.permissions.query({ name: 'notifications' as PermissionName })
        .then((status) => {
          const handler = () => notifyPermissionChanged();
          status.addEventListener('change', handler);
          teardown = () => status.removeEventListener('change', handler);
        })
        .catch(() => { /* unsupported — silent fallback to manual notify */ });
    }

    return () => {
      subscribers.delete(setPerm);
      teardown?.();
    };
  }, []);

  return perm;
}
