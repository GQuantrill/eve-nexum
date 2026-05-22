import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { setShareToken } from '../api/client';

/**
 * Tells every descendant component whether the app is rendering a
 * read-only share view, and which token authorises the ESI proxy calls.
 *
 * Components that should no-op in share mode (useFleet, useStandings,
 * useCharacterLocation, etc.) read isShareMode and bail early.
 * The api client module-level shareToken is also updated as the provider
 * mounts/unmounts so every outgoing request automatically picks it up.
 */
interface ShareModeValue {
  isShareMode: boolean;
  shareToken:  string | null;
}

const ShareModeContext = createContext<ShareModeValue>({ isShareMode: false, shareToken: null });

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

export function useShareMode(): ShareModeValue {
  return useContext(ShareModeContext);
}
