import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId: number;
    characterId: number;
    characterName: string;
    role: 'admin' | 'full' | 'edit' | 'readonly';
    userCorpId?: number | null;
    // The account (human) this session belongs to. All of the owner's
    // characters share it; the active character is `userId`.
    ownerId?: number;
    oauthState: string;
    // Set by GET /auth/add-character (only with an active session) so the
    // OAuth callback links the returning character to this owner instead of
    // starting a fresh login. Cleared once consumed.
    addCharacterOwnerId?: number;
    // Cached UI preferences — kept in sync by PATCH /auth/preferences so
    // /auth/me doesn't have to hit the DB on every page load.
    prefs: {
      compactMode: boolean;
      snapToGrid:  boolean;
      showMinimap: boolean;
      uniformSize: boolean;
      showStatics: boolean;
      easyConnect: boolean;
      connectionThickness: string;
      routeMode: string;
      uiZoom: number;
      uiSettings: Record<string, unknown>;
      panelOrder:  string[];
    };
  }
}
