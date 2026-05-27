// Stable per-tab identifier. Sent on every mutating request and echoed back on
// the realtime event, so a client can recognise — and skip — the live echo of
// its own change (it already applied it optimistically). Two tabs of the same
// user get different ids, so they still sync to each other.
export const CLIENT_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
