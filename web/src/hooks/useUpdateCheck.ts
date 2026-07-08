import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth, isAdminRole } from '../context/AuthContext';

interface VersionStatus {
  current:         string;
  latest:          string | null;
  updateAvailable: boolean;
  releaseUrl:      string | null;
}

const EMPTY: VersionStatus = { current: '', latest: null, updateAvailable: false, releaseUrl: null };
const POLL_MS = 30 * 60 * 1000; // 30 min — the server caches the GitHub result, so this is cheap

// Admin-only update check. Polls the (server-cached) version endpoint so the
// indicator appears without a reload when a new release ships. No-op for
// non-admins — the endpoint is admin-gated and we don't even call it.
export function useUpdateCheck(): VersionStatus {
  const user    = useAuth().user;
  const isAdmin = !!user && isAdminRole(user.role);
  const [status, setStatus] = useState<VersionStatus>(EMPTY);

  useEffect(() => {
    if (!isAdmin) return; // non-admins keep the EMPTY initial state; endpoint is admin-gated anyway
    let cancelled = false;
    const check = () => {
      api<VersionStatus>('/api/admin/version')
        .then((s) => { if (!cancelled) setStatus(s); })
        .catch(() => { /* best-effort — never surface a failed check */ });
    };
    check();
    const id = setInterval(check, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [isAdmin]);

  return status;
}
