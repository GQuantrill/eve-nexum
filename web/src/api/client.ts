const BASE = import.meta.env.VITE_API_URL ?? '';

// Module-level share-token holder. Set by ShareModeContext on mount and
// cleared when the share view unmounts. The API client appends it to every
// outgoing GET so the server's optionalAuth middleware can authorise the
// request, and refuses to send writes — share viewers are strictly read-only.
let shareToken: string | null = null;

export function setShareToken(token: string | null): void {
  shareToken = token;
}

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export async function api<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const method = (options?.method ?? 'GET').toUpperCase();

  // In share mode: block writes outright (no edits without an account) and
  // append the token to every read so the server can authorise it.
  let finalPath = path;
  if (shareToken) {
    if (WRITE_METHODS.has(method)) {
      throw new Error(`Cannot ${method} ${path} in share mode`);
    }
    finalPath = path + (path.includes('?') ? '&' : '?') + `shareToken=${encodeURIComponent(shareToken)}`;
  }

  const res = await fetch(`${BASE}${finalPath}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

export const apiUrl = (path: string) => `${BASE}${path}`;
