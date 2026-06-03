import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { seedUserSettings, readUserSetting } from './hooks/useUserSetting';
import { MapCanvas } from './components/map/MapCanvas';
import { SystemPanel } from './components/ui/SystemPanel';
import { ConnectionPanel } from './components/ui/ConnectionPanel';
import { Toolbar } from './components/ui/Toolbar';
import { MapSidebar } from './components/ui/MapSidebar';
import { Sidebar } from './components/ui/Sidebar';
import { ProximityOptInModal } from './components/ui/ProximityOptInModal';
import { CommandPaletteModal } from './components/ui/CommandPaletteModal';
import { LandingPage } from './components/ui/LandingPage';
import { Toaster, toast } from './components/ui/Toaster';
import i18n from './i18n';
import { TooltipLayer } from './components/ui/TooltipLayer';
import { AdminPage } from './components/ui/AdminPage';
import { SharedMapView } from './components/ui/SharedMapView';
import { useMapStore } from './store/mapStore';
import { useLocationTracking } from './hooks/useLocationTracking';
import { useMapEventStream } from './hooks/useMapEventStream';
import { useMapPresence } from './hooks/useMapPresence';
import { useHashRoute } from './hooks/useHashRoute';
import { usePageviewTracking } from './hooks/usePageviewTracking';
import { useIdleLock } from './hooks/useIdleLock';
import { LockScreen } from './components/ui/LockScreen';
import './App.css';

function MapApp() {
  const { user } = useAuth();
  const mapId               = useMapStore((s) => s.map.id);
  const selectedSystemId    = useMapStore((s) => s.selectedSystemId);
  const selectedConnectionId = useMapStore((s) => s.selectedConnectionId);
  const loadMaps            = useMapStore((s) => s.loadMaps);
  const applyPreferences    = useMapStore((s) => s.applyPreferences);
  const uiZoom              = useMapStore((s) => s.uiZoom);
  const resetUniformSizes   = useMapStore((s) => s.resetUniformSizes);

  // Apply the user's UI scale as a CSS custom property. App.css `font-size`
  // declarations multiply through `calc(Npx * var(--font-scale, 1))`, so
  // only text scales — layout boxes stay the same size and React Flow /
  // modal positioning math keeps working. Previously this used CSS
  // `zoom`, which broke `getBoundingClientRect` for click hit-tests and
  // shifted "centre on system" off-target.
  //
  // After the font scale changes, the natural width/height of every
  // SystemNode is now different. Drop the cached natural sizes so the
  // uniform-size clamp re-computes from fresh measurements; otherwise
  // nodes stay pinned to the old max.
  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(uiZoom));
    resetUniformSizes();
    return () => { document.documentElement.style.removeProperty('--font-scale'); };
  }, [uiZoom, resetUniformSizes]);

  // Only re-run when the user's identity changes, not on every shape mutation
  // of the user object (panel reorder, prefs toggle, etc).
  const userId = user?.id;

  useEffect(() => {
    if (user) {
      applyPreferences({ compactMode: user.compactMode, snapToGrid: user.snapToGrid, showMinimap: user.showMinimap, uniformSize: user.uniformSize, showStatics: user.showStatics, connectionThickness: user.connectionThickness, routeMode: user.routeMode, uiZoom: user.uiZoom, panelOrder: user.panelOrder });
      seedUserSettings(user.uiSettings ?? {});
      // Push the now-canonical trackJumps from the hydrated user-settings
      // cache into the map store. (mapStore's init runs before /auth/me
      // resolves, so it pulled from localStorage only.)
      useMapStore.setState({ trackJumps: readUserSetting<boolean>('nexum.trackJumps', true) });
    }
    loadMaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, loadMaps, applyPreferences]);

  // Re-fetch the maps list whenever the tab regains focus. Catches the
  // case where a map owner revoked a grant while the recipient had the
  // tab in the background — loadMaps' revocation-detection then bumps
  // them out of the now-inaccessible map automatically.
  useEffect(() => {
    if (!userId) return;
    const onFocus = () => { loadMaps(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [userId, loadMaps]);

  useLocationTracking(!!mapId);
  useMapEventStream();
  useMapPresence();

  return (
    <ReactFlowProvider>
      <div className="layout">
        <Toolbar />
        <div className="layout__body">
          <Sidebar />
          <div className="layout__main">
            <MapCanvas />
            <MapSidebar />
            {selectedSystemId && <SystemPanel />}
            {selectedConnectionId && <ConnectionPanel />}
          </div>
        </div>
      </div>
      <ProximityOptInModal />
      <CommandPaletteModal />
    </ReactFlowProvider>
  );
}

function AppShell() {
  const { user, loading, locked, unlock, logout } = useAuth();
  const [path] = useHashRoute();

  // Share links bypass the auth gate (see the early return below); computed up
  // here so the analytics page label can account for them too.
  const shareMatch = path.match(/^\/share\/([0-9a-fA-F-]{36})$/);

  // Logical page for GA4. Landing and map share the same '/' URL, so we send a
  // view-derived path rather than the raw URL: '/landing' when signed out,
  // '/map' for the map, the real path under '/admin', '/share' for share
  // links. null while auth is still loading, so we never log the wrong view.
  const analyticsPage = loading
    ? null
    : shareMatch
      ? '/share'
      : !user
        ? '/landing'
        : path.startsWith('/admin') && (user.canViewReports || (user.role === 'admin' && user.corpMode))
          ? path
          : '/map';
  usePageviewTracking(analyticsPage);

  // Idle-lock after 30 min (only while logged in and not already locked).
  // Pauses the UI without ending the session, so "Continue" resumes with no
  // SSO; the map unmounts while locked, stopping its ESI polling.
  useIdleLock(!!user && !locked);

  // After the add-character SSO flow the server redirects with ?added=<name>
  // on success or ?link_error=<code> on failure (e.g. the character isn't in
  // the corp). Toast the outcome once, then strip the params so a refresh
  // doesn't re-toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const added = params.get('added');
    const linkError = params.get('link_error');
    // The server adds ?login=success only on the redirect right after a real
    // EVE SSO login — so this fires once per login, not on every page load.
    const loggedIn = params.get('login') === 'success';
    if (!added && !linkError && !loggedIn) return;
    // Strip the params synchronously so a refresh — or StrictMode's dev
    // re-run of this effect — doesn't repeat the toast / re-fire analytics.
    const url = new URL(window.location.href);
    url.searchParams.delete('added');
    url.searchParams.delete('link_error');
    url.searchParams.delete('login');
    window.history.replaceState({}, '', url.toString());

    // Push a GTM "login" event so a tag can record the sign-in. dataLayer is
    // created by the GTM snippet in index.html; guard in case it's absent.
    if (loggedIn) {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: 'login', method: 'eve_sso' });
    }
    // Emit on a macrotask so the Toaster (a sibling) has subscribed before we
    // notify, and deliberately do NOT clear it on cleanup — otherwise
    // StrictMode's mount/unmount/remount would cancel it and nothing shows.
    setTimeout(() => {
      if (added) toast.success(i18n.t('account.characterAdded', { name: added }));
      if (linkError) toast.error(i18n.t(linkError === 'not_in_corp' ? 'account.linkFailedNotInCorp' : 'account.linkFailed'));
    }, 0);
  }, []);

  // Share links bypass the entire auth gate — a guest with the URL should
  // be able to load the map without ever seeing the landing page. Matched
  // (shareMatch is computed above) BEFORE the user/loading checks below.
  if (shareMatch) return <SharedMapView token={shareMatch[1]} />;

  if (loading) {
    return (
      <div className="loading-screen">
        <span className="loading-screen__logo">◈</span>
      </div>
    );
  }

  if (!user) return <LandingPage />;

  // Idle-locked: session is still valid, the UI is just paused. Rendering this
  // instead of the map unmounts the map (and its ESI polling); "Continue"
  // resumes instantly with no SSO.
  if (locked) return <LockScreen user={user} onResume={unlock} onLogout={logout} />;

  // Hash routes — admins reach /admin/* in corp mode (solo mode has no
  // other users to manage, so the section is hidden). The reports
  // character is always allowed regardless of corp mode.
  if (path.startsWith('/admin') && (user.canViewReports || (user.role === 'admin' && user.corpMode))) {
    return <AdminPage />;
  }

  return <MapApp />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
      <Toaster />
      <TooltipLayer />
    </AuthProvider>
  );
}
