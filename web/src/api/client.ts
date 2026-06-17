import { CLIENT_ID } from './clientId';

const BASE = import.meta.env.VITE_API_URL ?? '';

// Module-level share-token holder. Set by ShareModeContext on mount and
// cleared when the share view unmounts. The API client appends it to every
// outgoing GET so the server's optionalAuth middleware can authorise the
// request, and refuses to send writes — share viewers are strictly read-only.
let shareToken: string | null = null;

export function setShareToken(token: string | null): void {
  shareToken = token;
}

// When true, write requests (POST/PATCH/PUT/DELETE) are short-circuited to a
// resolved no-op instead of hitting the network. Used by nexumDebug's
// simulateJumps({ dryRun: true }) so the placement code can be exercised
// (e.g. logged out) without firing — or queuing — doomed map writes. The
// promise RESOLVES (not rejects), so callers' .catch(enqueue) never runs.
let writesSuppressed = false;

export function setWritesSuppressed(suppressed: boolean): void {
  writesSuppressed = suppressed;
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function api<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase();

  // Dry-run: swallow writes before any network work so they neither send nor
  // enqueue. Resolves undefined, matching a 204/empty response.
  if (writesSuppressed && WRITE_METHODS.has(method)) {
    return undefined as T;
  }

  // In share mode: block writes outright (no edits without an account) and
  // append the token to every read so the server can authorise it.
  let finalPath = path;
  if (shareToken) {
    if (WRITE_METHODS.has(method)) {
      throw new Error(`Cannot ${method} ${path} in share mode`);
    }
    finalPath = path + (path.includes('?') ? '&' : '?') + `shareToken=${encodeURIComponent(shareToken)}`;
  }

  const { headers: optHeaders, ...rest } = options ?? {};
  const res = await fetch(`${BASE}${finalPath}`, {
    credentials: 'include',
    ...rest,
    // Merge last so Content-Type / client id survive even when a caller passes
    // its own headers (previously `...options` could replace them wholesale).
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...optHeaders },
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  // A 204 (or otherwise empty) response has no body to parse — calling
  // res.json() on it throws "Unexpected end of JSON input". Treat no-content
  // responses as a successful undefined so callers that don't read the body
  // (DELETEs, etc.) don't surface a bogus error.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T;
  }
  return res.json() as Promise<T>;
}

export const apiUrl = (path: string) => `${BASE}${path}`;
