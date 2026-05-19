import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    characterId: number;
    characterName: string;
    role: 'admin' | 'full' | 'edit' | 'readonly';
    userCorpId?: number | null;
    oauthState: string;
    // Cached UI preferences — kept in sync by PATCH /auth/preferences so
    // /auth/me doesn't have to hit the DB on every page load.
    prefs: {
      compactMode: boolean;
      snapToGrid:  boolean;
      showMinimap: boolean;
      uniformSize: boolean;
      showStatics: boolean;
      panelOrder:  string[];
    };
  }
}
