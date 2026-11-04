import { api } from '../api/client';
import type { AuthUser } from '../context/AuthContext';
import { useMapStore, applyRemotePrefs } from '../store/mapStore';
import { applyRemoteSettings, seedUserSettings, readUserSetting } from '../hooks/useUserSetting';

// Settings changes pushed over the map event stream: from this character's
// other tabs and devices, and from linked characters when the account shares
// settings (see server/src/services/sharedSettings.ts).

/** A changed set of ui_settings keys. */
export function onSettingsChanged(entries: Record<string, unknown>): void {
  applyRemoteSettings(entries);
  // trackJumps is mirrored into the map store, which reads it once at load.
  if ('nexum.trackJumps' in entries) {
    useMapStore.setState({ trackJumps: readUserSetting<boolean>('nexum.trackJumps', true) });
  }
}

/** Changed preference columns, already in the store's shape. */
export function onPrefsChanged(prefs: Record<string, unknown>): void {
  applyRemotePrefs(prefs);
}

/** Everything may have changed (sharing was just turned on): reload it all. */
export async function resyncSettings(): Promise<void> {
  const { user } = await api<{ user: AuthUser | null }>('/auth/me');
  if (!user) return;
  useMapStore.getState().applyPreferences({
    compactMode: user.compactMode, snapToGrid: user.snapToGrid, showMinimap: user.showMinimap,
    uniformSize: user.uniformSize, showStatics: user.showStatics, easyConnect: user.easyConnect,
    connectionThickness: user.connectionThickness, routeMode: user.routeMode, uiZoom: user.uiZoom,
    panelOrder: user.panelOrder,
  });
  seedUserSettings(user.uiSettings ?? {}, user.orgDefaults ?? {});
  useMapStore.setState({ trackJumps: readUserSetting<boolean>('nexum.trackJumps', true) });
}
