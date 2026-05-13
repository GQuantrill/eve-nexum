import { useRef } from 'react';
import { useMapStore } from '../../store/mapStore';
import { api } from '../../api/client';
import { toast } from './Toaster';
import { pickHandles } from '../map/edgeUtils';
import type { WormholeMap } from '../../types';

export function MapSidebar() {
  const importInputRef = useRef<HTMLInputElement>(null);

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
        <div className="map-sidebar__title">Map Options</div>

        <div className="map-sidebar__section">
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
        </div>

                <div className="map-sidebar__divider" />

        <div className="map-sidebar__section">
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
          >
            ⊞ Spread Nodes
          </button>
        </div>

        <div className="map-sidebar__divider" />

        <div className="map-sidebar__section">
          <div className="map-sidebar__label" style={{ marginBottom: 6 }}>Connection Style</div>
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
        </div>



        <div className="map-sidebar__divider" />

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
        </div>
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
