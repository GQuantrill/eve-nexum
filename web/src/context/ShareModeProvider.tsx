import { useEffect, type ReactNode } from 'react';
import { setShareToken } from '../api/client';
import { ShareModeContext } from './ShareModeContext';

/**
 * Publishes share-mode state to the tree, and keeps the api client's
 * module-level share token in step as it mounts and unmounts so every outgoing
 * request picks it up automatically.
 */
export function ShareModeProvider({ token, children }: { token: string | null; children: ReactNode }) {
  useEffect(() => {
    setShareToken(token);
    return () => setShareToken(null);
  }, [token]);

  return (
    <ShareModeContext.Provider value={{ isShareMode: !!token, shareToken: token }}>
      {children}
    </ShareModeContext.Provider>
  );
}
