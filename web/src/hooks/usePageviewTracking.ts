import { useEffect, useRef } from 'react';

// Fire a GA4 "page_view" into the dataLayer on every hash-route change.
//
// The app is a hash-router SPA, so client-side navigation never reloads the
// page and never touches the History API — which means GA4 (and its
// Enhanced Measurement "history events" option) can't see it. Only the very
// first load is counted by the GA4 config tag's automatic page_view. This
// hook covers every subsequent navigation.
//
// We skip the initial render (the config tag already counted it) and send a
// synthetic page_location with the hash flattened into the path
// (https://host/admin/users, not https://host/#/admin/users) so GA4's reports
// show clean, distinct page paths instead of collapsing everything onto "/".
export function usePageviewTracking(path: string): void {
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const clean = path.startsWith('/') ? path : `/${path}`;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event:         'page_view',
      page_path:     clean,
      page_location: window.location.origin + clean,
      page_title:    document.title,
    });
  }, [path]);
}
