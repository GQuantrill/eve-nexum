import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNotificationPermission, notifyPermissionChanged } from '../../hooks/useNotificationPermission';
import { useMapStore } from '../../store/mapStore';
import { useAuth } from '../../context/AuthContext';
import { api } from '../../api/client';
import { toast } from './Toaster';
import { pickHandles } from '../map/edgeUtils';
import { useProximityThreshold } from '../../hooks/useProximityAlerts';
import { useStaleThreshold } from '../../hooks/useStaleThreshold';
import { toPng } from 'html-to-image';
import type { WormholeMap } from '../../types';

// Collapsible group inside the map sidebar. Open/closed state is persisted to
// localStorage per `storageKey` so each user keeps their preferred layout
// across reloads.
function CollapsibleSection({
  title,
  storageKey,
  defaultOpen = true,
  children,
}: {
  title: string;
  storageKey: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? defaultOpen : v === '1';
    } catch { return defaultOpen; }
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, open ? '1' : '0'); } catch { /* quota / private mode */ }
  }, [open, storageKey]);

  return (
    <div className={`map-sidebar__section${open ? '' : ' map-sidebar__section--collapsed'}`}>
      <button
        type="button"
        className="map-sidebar__section-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="map-sidebar__section-title">{title}</span>
        <span className={`map-sidebar__caret${open ? ' map-sidebar__caret--open' : ''}`}>▾</span>
      </button>
      {open && <div className="map-sidebar__section-body">{children}</div>}
    </div>
  );
}

export function MapSidebar() {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [threshold, setThreshold] = useProximityThreshold();
  const [staleHours, setStaleHours] = useStaleThreshold();
  const notifPermission = useNotificationPermission();
  const { user } = useAuth();
  const isCorpMap = useMapStore((s) => !!s.map.isCorpMap);
  // The map-management buttons (optimize / spread / JSON / PNG / stale fade)
  // are hidden only when a readonly user is looking at a corp map. On their
  // own personal map a readonly user still owns the layout and can use the
  // full toolkit.
  const hideTopologyTools = user?.role === 'readonly' && isCorpMap;

  function requestNotifPermission() {
    if (typeof Notification === 'undefined') return;
    Notification.requestPermission().finally(() => notifyPermissionChanged());
  }

  async function handleExportPng() {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
    const flow     = document.querySelector<HTMLElement>('.react-flow');
    const target   = viewport ?? flow;
    if (!target) { toast.error('Could not find the map canvas'); return; }
    try {
      const dataUrl = await toPng(target, {
        backgroundColor: '#08101a',
        pixelRatio: 2,
        filter: (node) => {
          // Skip ReactFlow's own controls / minimap / attribution from the export
          if (!(node instanceof HTMLElement)) return true;
          return !node.classList?.contains?.('react-flow__minimap')
              && !node.classList?.contains?.('react-flow__controls')
              && !node.classList?.contains?.('react-flow__attribution')
              && !node.classList?.contains?.('react-flow__panel');
        },
      });
      const link = document.createElement('a');
      const { map } = useMapStore.getState();
      const safeName = (map.name || 'map').replace(/[^a-z0-9]/gi, '_');
      link.download = `nexum_${safeName}_${new Date().toISOString().split('T')[0]}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      toast.error(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }


  const maps             = useMapStore((s) => s.maps);
  const maxMaps          = useMapStore((s) => s.maxMaps);
  const snapToGrid       = useMapStore((s) => s.snapToGrid);
  const setSnapToGrid    = useMapStore((s) => s.setSnapToGrid);
  const compactMode      = useMapStore((s) => s.compactMode);
  const setCompactMode   = useMapStore((s) => s.setCompactMode);
  const showMinimap      = useMapStore((s) => s.showMinimap);
  const setShowMinimap   = useMapStore((s) => s.setShowMinimap);
  const easyConnect      = useMapStore((s) => s.easyConnect);
  const setEasyConnect   = useMapStore((s) => s.setEasyConnect);
  const mapOptionsOpen   = useMapStore((s) => s.mapOptionsOpen);
  const setMapOptionsOpen = useMapStore((s) => s.setMapOptionsOpen);
  const edgeStyle        = useMapStore((s) => s.edgeStyle);
  const setEdgeStyle     = useMapStore((s) => s.setEdgeStyle);
  const updateConnection = useMapStore((s) => s.updateConnection);
  const requestAutoLayout = useMapStore((s) => s.requestAutoLayout);
  const connectionCount  = useMapStore((s) => s.map.connections.length);
  const systemCount      = useMapStore((s) => s.map.systems.length);

  const atMapLimit = maps.length >= maxMaps;

  function handleOptimizeConnections() {
    // Reach into the live store snapshot — operating on per-render selectors
    // here would lock us into the snapshot captured at button-click time.
    const { map } = useMapStore.getState();
    const systemMap = new Map(map.systems.map((s) => [s.id, s.position]));
    for (const conn of map.connections) {
      const src = systemMap.get(conn.sourceId);
      const tgt = systemMap.get(conn.targetId);
      if (!src || !tgt) continue;
      const { sourceHandle, targetHandle } = pickHandles(src, tgt);
      if (conn.sourceHandle !== sourceHandle || conn.targetHandle !== targetHandle) {
        updateConnection(conn.id, { sourceHandle, targetHandle });
      }
    }
  }

  function handleExport() {
    const { map } = useMapStore.getState();
    const json = JSON.stringify(map, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${map.name.replace(/[^a-z0-9]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(file: File) {
    let parsed: WormholeMap;
    try {
      parsed = JSON.parse(await file.text()) as WormholeMap;
    } catch {
      toast.error('Invalid JSON file.');
      return;
    }
    if (!parsed.systems || !parsed.connections) {
      toast.error('File does not look like a Eve-Nexum map export.');
      return;
    }
    try {
      const { id } = await api<{ id: string }>('/api/maps/import', {
        method: 'POST',
        body: JSON.stringify({ name: parsed.name, systems: parsed.systems, connections: parsed.connections }),
      });
      await useMapStore.getState().loadMaps();
      await useMapStore.getState().switchMap(id);
    } catch (err) {
      toast.error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className={`map-sidebar${mapOptionsOpen ? ' map-sidebar--open' : ''}`}>
      <button
        className="map-sidebar__tab"
        onClick={() => setMapOptionsOpen(!mapOptionsOpen)}
        title={mapOptionsOpen ? 'Close map options' : 'Map options'}
      >
        {mapOptionsOpen ? '›' : '‹'}
      </button>

      <div className="map-sidebar__content">
        <CollapsibleSection title="Map Options" storageKey="nexum.mapSidebar.mapOptions">
          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Snap to Grid</label>
            <button
              className={`toolbar__toggle${snapToGrid ? ' toolbar__toggle--on' : ''}`}
              onClick={() => setSnapToGrid(!snapToGrid)}
              aria-pressed={snapToGrid}
            >
              {snapToGrid ? 'On' : 'Off'}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Compact</label>
            <button
              className={`toolbar__toggle${compactMode ? ' toolbar__toggle--on' : ''}`}
              onClick={() => setCompactMode(!compactMode)}
              aria-pressed={compactMode}
            >
              {compactMode ? 'On' : 'Off'}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Minimap</label>
            <button
              className={`toolbar__toggle${showMinimap ? ' toolbar__toggle--on' : ''}`}
              onClick={() => setShowMinimap(!showMinimap)}
              aria-pressed={showMinimap}
            >
              {showMinimap ? 'On' : 'Off'}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Easy Connect</label>
            <button
              className={`toolbar__toggle${easyConnect ? ' toolbar__toggle--on' : ''}`}
              onClick={() => setEasyConnect(!easyConnect)}
              aria-pressed={easyConnect}
            >
              {easyConnect ? 'On' : 'Off'}
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Connections" storageKey="nexum.mapSidebar.connections">
          <div className="map-sidebar__label">Connection Style</div>
          <div className="map-sidebar__btn-group">
            {([
              { value: 'bezier',     label: 'Standard' },
              { value: 'straight',   label: 'Straight' },
              { value: 'smoothstep', label: 'Step' },
            ] as const).map(({ value, label }) => (
              <button
                key={value}
                className={`map-sidebar__btn-group-item${edgeStyle === value ? ' map-sidebar__btn-group-item--active' : ''}`}
                onClick={() => setEdgeStyle(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {!hideTopologyTools && (
            <>
              <button
                className="map-sidebar__action"
                onClick={handleOptimizeConnections}
                disabled={connectionCount === 0}
              >
                ⟳ Optimize Connections
              </button>
              <button
                className="map-sidebar__action"
                onClick={requestAutoLayout}
                disabled={systemCount < 2}
                data-tooltip="Adjust system nodes to stop overlapping"
              >
                ⊞ Spread Nodes
              </button>
            </>
          )}
        </CollapsibleSection>

        <CollapsibleSection title="Proximity Alerts" storageKey="nexum.mapSidebar.proximity">
          <div className="map-sidebar__row">
            <label className="map-sidebar__label" htmlFor="proximity-threshold">Threshold</label>
            <select
              id="proximity-threshold"
              className="map-sidebar__select"
              value={threshold}
              onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
            >
              <option value={0}>0 jumps (in system)</option>
              <option value={1}>≤ 1 jump</option>
              <option value={2}>≤ 2 jumps</option>
              <option value={3}>≤ 3 jumps</option>
              <option value={4}>≤ 4 jumps</option>
              <option value={5}>≤ 5 jumps</option>
            </select>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Browser Notifications</label>
            {notifPermission === 'granted' ? (
              <span className="map-sidebar__status map-sidebar__status--ok">Enabled</span>
            ) : notifPermission === 'denied' ? (
              <span
                className="map-sidebar__status map-sidebar__status--err"
                data-tooltip="Click the lock / site-info icon in your address bar → Notifications → Allow, then reload."
              >
                Blocked
              </span>
            ) : (
              <button
                type="button"
                className="toolbar__toggle"
                onClick={requestNotifPermission}
              >
                Enable
              </button>
            )}
          </div>
          {notifPermission === 'denied' && (
            <div className="map-sidebar__hint">
              Browser is blocking notifications for this site. Click the lock icon in
              your address bar → Notifications → Allow → reload the page.
            </div>
          )}
        </CollapsibleSection>

        {!hideTopologyTools && (
          <CollapsibleSection title="Stale System Fade" storageKey="nexum.mapSidebar.stale">
            <div className="map-sidebar__row">
              <label className="map-sidebar__label" htmlFor="stale-threshold">Threshold</label>
              <select
                id="stale-threshold"
                className="map-sidebar__select"
                value={staleHours}
                onChange={(e) => setStaleHours(parseInt(e.target.value, 10))}
              >
                <option value={1}>1 hour</option>
                <option value={4}>4 hours</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
                <option value={48}>48 hours</option>
                <option value={168}>1 week</option>
                <option value={720}>1 month</option>
              </select>
            </div>
          </CollapsibleSection>
        )}

        {!hideTopologyTools && (
          <CollapsibleSection title="Export" storageKey="nexum.mapSidebar.export">
          <div className="map-sidebar__section">
            <button className="map-sidebar__action" onClick={handleExport}>
              ↓ Export as JSON
            </button>

            <div className={`map-sidebar__import-wrap${atMapLimit ? ' map-sidebar__import-wrap--disabled' : ''}`}>
              <button
                className="map-sidebar__action"
                onClick={() => importInputRef.current?.click()}
                disabled={atMapLimit}
              >
                ↑ Import from JSON
              </button>
            </div>
            <button
              type="button"
              className="map-sidebar__action"
              onClick={handleExportPng}
              disabled={systemCount === 0}
            >
              ⎙ Export as PNG
            </button>
          </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection title="Shortcuts" storageKey="nexum.mapSidebar.shortcuts" defaultOpen={false}>
          <div className="map-sidebar__shortcut">
            <kbd>⌘/Ctrl + K</kbd>
            <span>Search systems &amp; maps</span>
          </div>
          <div className="map-sidebar__shortcut">
            <kbd>H</kbd>
            <span>Centre on home system</span>
          </div>
          <div className="map-sidebar__shortcut">
            <kbd>Del</kbd>
            <span>Remove selected systems</span>
          </div>
          <div className="map-sidebar__shortcut">
            <kbd>⌘/Ctrl + Z</kbd>
            <span>Undo</span>
          </div>
          <div className="map-sidebar__shortcut">
            <kbd>Shift + click</kbd>
            <span>Multi-select systems</span>
          </div>
          <div className="map-sidebar__shortcut">
            <kbd>Shift + drag</kbd>
            <span>Rubber-band select systems</span>
          </div>
        </CollapsibleSection>
      </div>

      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImport(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}
