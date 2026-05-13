import { useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { MapCanvas } from './components/map/MapCanvas';
import { SystemPanel } from './components/ui/SystemPanel';
import { ConnectionPanel } from './components/ui/ConnectionPanel';
import { Toolbar } from './components/ui/Toolbar';
import { MapSidebar } from './components/ui/MapSidebar';
import { LandingPage } from './components/ui/LandingPage';
import { Toaster } from './components/ui/Toaster';
import { useMapStore } from './store/mapStore';
import { useLocationTracking } from './hooks/useLocationTracking';
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
          <MapCanvas />
          <MapSidebar />
          {selectedSystemId && <SystemPanel />}
          {selectedConnectionId && <ConnectionPanel />}
        </div>
      </div>
    </ReactFlowProvider>
  );
}

function AppShell() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <span className="loading-screen__logo">◈</span>
      </div>
    );
  }

  if (!user) return <LandingPage />;

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
