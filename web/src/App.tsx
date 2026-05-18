import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { MapCanvas } from './components/map/MapCanvas';
import { SystemPanel } from './components/ui/SystemPanel';
import { ConnectionPanel } from './components/ui/ConnectionPanel';
import { Toolbar } from './components/ui/Toolbar';
import { MapSidebar } from './components/ui/MapSidebar';
import { Sidebar } from './components/ui/Sidebar';
import { ProximityOptInModal } from './components/ui/ProximityOptInModal';
import { CommandPaletteModal } from './components/ui/CommandPaletteModal';
import { LandingPage } from './components/ui/LandingPage';
import { Toaster } from './components/ui/Toaster';
import { AdminPage } from './components/ui/AdminPage';
import { useMapStore } from './store/mapStore';
import { useLocationTracking } from './hooks/useLocationTracking';
import { useHashRoute } from './hooks/useHashRoute';
import './App.css';

function MapApp() {
  const { user } = useAuth();
  const mapId               = useMapStore((s) => s.map.id);
  const selectedSystemId    = useMapStore((s) => s.selectedSystemId);
  const selectedConnectionId = useMapStore((s) => s.selectedConnectionId);
  const loadMaps            = useMapStore((s) => s.loadMaps);
  const applyPreferences    = useMapStore((s) => s.applyPreferences);

  // Only re-run when the user's identity changes, not on every shape mutation
  // of the user object (panel reorder, prefs toggle, etc).
  const userId = user?.id;

  useEffect(() => {
    if (user) applyPreferences({ compactMode: user.compactMode, snapToGrid: user.snapToGrid, showMinimap: user.showMinimap, panelOrder: user.panelOrder });
    loadMaps();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, loadMaps, applyPreferences]);

  useLocationTracking(!!mapId);

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
    </AuthProvider>
  );
}
