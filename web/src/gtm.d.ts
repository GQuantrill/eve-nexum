// Google Tag Manager's dataLayer queue, created by the GTM snippet in
// index.html. We push app events (e.g. { event: 'login' }) onto it for tags
// configured in the GTM UI to react to.
export {};

declare global {
  interface Window {
    dataLayer?: Record<string, unknown>[];
  }
}
