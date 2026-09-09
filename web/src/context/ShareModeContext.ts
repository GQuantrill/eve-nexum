import { createContext, useContext } from 'react';

/**
 * Tells every descendant component whether the app is rendering a
 * read-only share view, and which token authorises the ESI proxy calls.
 *
 * Components that should no-op in share mode (useFleet, useStandings,
 * useCharacterLocation, etc.) read isShareMode and bail early.
 *
 * The provider lives in ShareModeProvider.tsx so this file exports no
 * components — mixing the two breaks Fast Refresh for the module.
 */
export interface ShareModeValue {
  isShareMode: boolean;
  shareToken:  string | null;
}

export const ShareModeContext = createContext<ShareModeValue>({ isShareMode: false, shareToken: null });

export function useShareMode(): ShareModeValue {
  return useContext(ShareModeContext);
}
