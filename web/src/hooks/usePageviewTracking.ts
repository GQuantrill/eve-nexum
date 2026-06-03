import { useEffect, useRef } from 'react';

// Fire a GA4 "page_view" into the dataLayer whenever the logical view changes.
//
// The app is a hash-router SPA, so client-side navigation never reloads the
// page or touches the History API — GA4 (and its Enhanced Measurement
// "history events" option) can't see it. On top of that, several views share
// the same URL: the landing page and the map both live at "/". So instead of
// the raw URL we send a caller-computed *logical* page ("/landing", "/map",
// "/admin/users", ...) that reflects what's actually rendered.
//
// `page` is null while the view is still undecided (auth loading); we hold off
// until it resolves so we never log the wrong view. Because this fires the
// first real view itself, the GA4 config tag's automatic page_view should be
// turned OFF (send_page_view = false) so the initial load isn't counted twice.
export function usePageviewTracking(page: string | null): void {
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!page || page === last.current) return;
    last.current = page;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event:         'page_view',
      page_path:     page,
      page_location: window.location.origin + page,
      page_title:    document.title,
    });
  }, [page]);
}
