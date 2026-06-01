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
  const { user, loading } = useAuth();
  const [path] = useHashRoute();

  // After the add-character SSO flow the server redirects with ?added=<name>.
  // Confirm it once, then strip the param so a refresh doesn't re-toast.
  useEffect(() => {
    const added = new URLSearchParams(window.location.search).get('added');
    if (!added) return;
    toast.success(i18n.t('account.characterAdded', { name: added }));
    const url = new URL(window.location.href);
    url.searchParams.delete('added');
    window.history.replaceState({}, '', url.toString());
  }, []);

  // Share links bypass the entire auth gate — a guest with the URL should
  // be able to load the map without ever seeing the landing page. Match
  // BEFORE the user/loading checks below.
  const shareMatch = path.match(/^\/share\/([0-9a-fA-F-]{36})$/);
  if (shareMatch) return <SharedMapView token={shareMatch[1]} />;

  if (loading) {
    return (
      <div className="loading-screen">
        <span className="loading-screen__logo">◈</span>
      </div>
    );
  }

  if (!user) return <LandingPage />;

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
