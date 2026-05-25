import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useNotificationPermission,
  notifyPermissionChanged,
} from "../../hooks/useNotificationPermission";
import { useMapStore } from "../../store/mapStore";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../api/client";
import { toast } from "./Toaster";
import { pickHandles } from "../map/edgeUtils";
import { useProximityThreshold } from "../../hooks/useProximityAlerts";
import { useStaleThreshold } from "../../hooks/useStaleThreshold";
import {
  useMinimapPosition,
  type MinimapPosition,
} from "../../hooks/useMinimapPosition";
import { useUserSetting } from "../../hooks/useUserSetting";
import { toPng } from "html-to-image";
import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import { ChainExitsSection } from "./ChainExitsSection";
import { MapSharesSection } from "./MapSharesSection";
import { CustomIntelBlock } from "./CustomIntelBlock";
import { useIsMapOwner } from "../../hooks/useIsMapOwner";
import type { WormholeMap } from "../../types";

// Single labelled checkbox row backed by useUserSetting so the on/off
// state syncs cross-device via users.ui_settings. Used by the Activity
// and Fleet sections — anywhere a section needs a row of plain on/off
// flags, this is the building block.
function SettingToggle({
  settingKey,
  label,
}: {
  settingKey: string;
  label: string;
}) {
  const [enabled, setEnabled] = useUserSetting<boolean>(settingKey, true);
  return (
    <label className="map-sidebar__row map-sidebar__toggle-row">
      <span className="map-sidebar__label">{label}</span>
      <input
        type="checkbox"
        className="map-sidebar__toggle-input"
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
    </label>
  );
}

// Accordion-style section. State is *not* owned here — MapSidebar tracks
// a single "which section is open" key, and each section receives its
// isOpen + onToggle from above. Clicking a closed section opens it (and
// implicitly closes the previously open one); clicking the open section
// closes it back to nothing-open.
function CollapsibleSection({
  title,
  isOpen,
  onToggle,
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`map-sidebar__section${isOpen ? "" : " map-sidebar__section--collapsed"}`}
    >
      <button
        type="button"
        className="map-sidebar__section-header"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <span className="map-sidebar__section-title">{title}</span>
        <span
          className={`map-sidebar__caret${isOpen ? " map-sidebar__caret--open" : ""}`}
        >
          ▾
        </span>
      </button>
      {isOpen && <div className="map-sidebar__section-body">{children}</div>}
    </div>
  );
}

// Accordion identity for each section. Stored as the value of the single
// shared "which section is open" setting; null means everything collapsed.
type SectionId =
  | "mapOptions"
  | "systemOptions"
  | "connections"
  | "route"
  | "chainExits"
  | "proximityAlerts"
  | "activity"
  | "fleet"
  | "share"
  | "shareGrants"
  | "staleFade"
  | "export"
  | "shortcuts"
  | null;

// Share permissions mirror the server's requireShareAdmin: corp maps are
// admin-only, personal maps are owner-only. A personal map can now reach
// the user via a map_shares grant (sharedWithMe = true), in which case
// they're a recipient — not the owner — and must not see the share-link
// controls.
function canShareThisMap(
  user: { role?: string } | null | undefined,
  isCorpMap: boolean,
  isMapOwner: boolean,
): boolean {
  if (!user) return false;
  if (isCorpMap) return user.role === "admin";
  return isMapOwner;
}

// Expiry windows offered to the share-link generator. Mirror the server's
// SHARE_EXPIRY_HOURS_ALLOWED — anything not on this list is rejected.
const SHARE_EXPIRY_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: "1 hour" },
  { hours: 12, label: "12 hours" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "1 week" },
];
const SHARE_EXPIRY_DEFAULT = 24;

function ShareSection() {
  const map = useMapStore((s) => s.map);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Toggle state. When there's no active link these are the seed values
  // sent to /share on create. When a link IS active they mirror the
  // map's persisted flags and flipping them sends a PATCH that updates
  // the live link without rotating the token. Defaults are FALSE so a
  // freshly-created link starts intel-free; the owner opts in per row.
  const activeFlags = !!map.shareToken;
  const effectiveSigs = activeFlags ? map.shareIncludeSigs === true : false;
  const effectiveBridges = activeFlags
    ? map.shareIncludeBridges === true
    : false;
  const effectiveNotes = activeFlags ? map.shareIncludeNotes === true : false;
  const effectiveStructures = activeFlags
    ? map.shareIncludeStructures === true
    : false;
  const [includeSigs, setIncludeSigs] = useState(effectiveSigs);
  const [includeBridges, setIncludeBridges] = useState(effectiveBridges);
  const [includeNotes, setIncludeNotes] = useState(effectiveNotes);
  const [includeStructures, setIncludeStructures] =
    useState(effectiveStructures);
  // Expiry is generation-time only — it doesn't sync from the map state
  // because once a link exists its expiry is just shown as a countdown.
  const [expiryHours, setExpiryHours] = useState<number>(SHARE_EXPIRY_DEFAULT);
  useEffect(() => {
    setIncludeSigs(effectiveSigs);
  }, [effectiveSigs]);
  useEffect(() => {
    setIncludeBridges(effectiveBridges);
  }, [effectiveBridges]);
  useEffect(() => {
    setIncludeNotes(effectiveNotes);
  }, [effectiveNotes]);
  useEffect(() => {
    setIncludeStructures(effectiveStructures);
  }, [effectiveStructures]);

  // 1-minute heartbeat so the countdown label stays roughly accurate
  // without taxing the render loop. Hovering granularity isn't useful
  // for a 48-hour countdown anyway.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const expiresAt = map.shareExpiresAt
    ? new Date(map.shareExpiresAt).getTime()
    : 0;
  const isActive = !!map.shareToken && expiresAt > now;
  const url = isActive
    ? `${window.location.origin}/#/share/${map.shareToken}`
    : "";

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{
        token: string;
        url: string;
        expiresAt: string;
        includeSigs: boolean;
        includeBridges: boolean;
        includeNotes: boolean;
        includeStructures: boolean;
      }>(`/api/maps/${map.id}/share`, {
        method: "POST",
        body: JSON.stringify({
          includeSigs,
          includeBridges,
          includeNotes,
          includeStructures,
          expiryHours,
        }),
      });
      useMapStore.setState((s) => ({
        map: {
          ...s.map,
          shareToken: r.token,
          shareExpiresAt: r.expiresAt,
          shareIncludeSigs: r.includeSigs,
          shareIncludeBridges: r.includeBridges,
          shareIncludeNotes: r.includeNotes,
          shareIncludeStructures: r.includeStructures,
        },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create share link");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/maps/${map.id}/share`, { method: "DELETE" });
      useMapStore.setState((s) => ({
        map: { ...s.map, shareToken: null, shareExpiresAt: null },
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke share link");
    } finally {
      setBusy(false);
    }
  }

  function copyUrl() {
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => toast.success("Live map link copied"),
      () => toast.error("Copy failed — select and copy manually"),
    );
  }

  function formatRemaining(): string {
    const ms = expiresAt - now;
    if (ms <= 0) return "expired";
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (h > 0) return `expires in ${h}h ${m}m`;
    return `expires in ${m}m`;
  }

  // Update toggle state locally and, if a link is live, push a PATCH so
  // the same token starts returning the new payload shape next request.
  type TogglePatch = {
    includeSigs?: boolean;
    includeBridges?: boolean;
    includeNotes?: boolean;
    includeStructures?: boolean;
  };
  async function applyToggle(patch: TogglePatch) {
    if (patch.includeSigs !== undefined) setIncludeSigs(patch.includeSigs);
    if (patch.includeBridges !== undefined)
      setIncludeBridges(patch.includeBridges);
    if (patch.includeNotes !== undefined) setIncludeNotes(patch.includeNotes);
    if (patch.includeStructures !== undefined)
      setIncludeStructures(patch.includeStructures);
    if (!isActive) return;
    setError(null);
    try {
      await api(`/api/maps/${map.id}/share`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      useMapStore.setState((s) => ({
        map: {
          ...s.map,
          shareIncludeSigs: patch.includeSigs ?? s.map.shareIncludeSigs,
          shareIncludeBridges:
            patch.includeBridges ?? s.map.shareIncludeBridges,
          shareIncludeNotes: patch.includeNotes ?? s.map.shareIncludeNotes,
          shareIncludeStructures:
            patch.includeStructures ?? s.map.shareIncludeStructures,
        },
      }));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to update share options",
      );
    }
  }

  return (
    <>
      <div className="map-sidebar__hint">
        {isActive
          ? "Live share link. Toggle below to change what guests see. If a link was previously generated, the changes will take effect automatically and you DO NOT need to regenerate."
          : "Create a read-only link anyone can open without an account. Pick categories to expose and an expiry window — anyone holding the URL within that window can see everything you opted in."}
      </div>

      {!isActive && (
        <div className="map-sidebar__row">
          <label className="map-sidebar__label" htmlFor="share-expiry">
            Link expires after
          </label>
          <select
            id="share-expiry"
            className="map-sidebar__select"
            value={expiryHours}
            onChange={(e) => setExpiryHours(parseInt(e.target.value, 10))}
          >
            {SHARE_EXPIRY_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">Include signatures</span>
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={includeSigs}
          onChange={(e) => applyToggle({ includeSigs: e.target.checked })}
        />
      </label>
      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">Show jump bridges</span>
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={includeBridges}
          onChange={(e) => applyToggle({ includeBridges: e.target.checked })}
        />
      </label>
      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">Include structures</span>
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={includeStructures}
          onChange={(e) => applyToggle({ includeStructures: e.target.checked })}
        />
      </label>
      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">Include notes</span>
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={includeNotes}
          onChange={(e) => applyToggle({ includeNotes: e.target.checked })}
        />
      </label>

      {isActive ? (
        <>
          <div className="map-sidebar__share-url" title={url}>
            {url}
          </div>
          <div className="map-sidebar__share-meta">{formatRemaining()}</div>
          <button
            className="map-sidebar__action"
            onClick={copyUrl}
            disabled={busy}
          >
            Copy link
          </button>
          <button
            className="map-sidebar__action"
            onClick={revoke}
            disabled={busy}
          >
            {busy ? "Working…" : "Revoke"}
          </button>
        </>
      ) : (
        <button
          className="map-sidebar__action"
          onClick={generate}
          disabled={busy}
        >
          {busy ? "Working…" : "Create share link"}
        </button>
      )}

      {error && (
        <div className="map-sidebar__hint map-sidebar__hint--error">
          {error}
        </div>
      )}
    </>
  );
}

export function MapSidebar() {
  const importInputRef = useRef<HTMLInputElement>(null);
  const [threshold, setThreshold] = useProximityThreshold();
  const [staleHours, setStaleHours] = useStaleThreshold();
  // Single source of truth for which section is expanded. Defaults to
  // Map Options so first-load users see something useful immediately.
  const [openSection, setOpenSection] = useUserSetting<SectionId>(
    "nexum.mapSidebar.openSection",
    "mapOptions",
  );
  const sectionProps = (id: SectionId) => ({
    isOpen: openSection === id,
    onToggle: () => setOpenSection((cur) => (cur === id ? null : id)),
  });
  const notifPermission = useNotificationPermission();
  const { user } = useAuth();
  const isCorpMap = useMapStore((s) => !!s.map.isCorpMap);
  const isMapOwner = useIsMapOwner();
  // Per-character / per-corp share grants are personal-map only and
  // owner-only. Hide the section anywhere else so it doesn't suggest
  // an action that would fail at the server.
  const canManageShareGrants = isMapOwner && !isCorpMap;
  // The map-management buttons (optimize / spread / JSON / PNG / stale fade)
  // are hidden only when a readonly user is looking at a corp map. On their
  // own personal map a readonly user still owns the layout and can use the
  // full toolkit.
  const hideTopologyTools = user?.role === "readonly" && isCorpMap;

  function requestNotifPermission() {
    if (typeof Notification === "undefined") return;
    Notification.requestPermission().finally(() => notifyPermissionChanged());
  }

  async function handleExportPng() {
    const viewport = document.querySelector<HTMLElement>(
      ".react-flow__viewport",
    );
    const flow = document.querySelector<HTMLElement>(".react-flow");
    const target = viewport ?? flow;
    if (!target) {
      toast.error("Could not find the map canvas");
      return;
    }
    try {
      const dataUrl = await toPng(target, {
        backgroundColor: "#08101a",
        pixelRatio: 2,
        filter: (node) => {
          // Skip ReactFlow's own controls / minimap / attribution from the export
          if (!(node instanceof HTMLElement)) return true;
          return (
            !node.classList?.contains?.("react-flow__minimap") &&
            !node.classList?.contains?.("react-flow__controls") &&
            !node.classList?.contains?.("react-flow__attribution") &&
            !node.classList?.contains?.("react-flow__panel")
          );
        },
      });
      const link = document.createElement("a");
      const { map } = useMapStore.getState();
      const safeName = (map.name || "map").replace(/[^a-z0-9]/gi, "_");
      link.download = `nexum_${safeName}_${new Date().toISOString().split("T")[0]}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      toast.error(
        `Export failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const maps = useMapStore((s) => s.maps);
  const maxMaps = useMapStore((s) => s.maxMaps);
  const snapToGrid = useMapStore((s) => s.snapToGrid);
  const setSnapToGrid = useMapStore((s) => s.setSnapToGrid);
  const compactMode = useMapStore((s) => s.compactMode);
  const setCompactMode = useMapStore((s) => s.setCompactMode);
  const showMinimap = useMapStore((s) => s.showMinimap);
  const setShowMinimap = useMapStore((s) => s.setShowMinimap);
  const [minimapPosition, setMinimapPosition] = useMinimapPosition();
  const uniformSize = useMapStore((s) => s.uniformSize);
  const setUniformSize = useMapStore((s) => s.setUniformSize);
  const showStatics = useMapStore((s) => s.showStatics);
  const setShowStatics = useMapStore((s) => s.setShowStatics);
  const easyConnect = useMapStore((s) => s.easyConnect);
  const setEasyConnect = useMapStore((s) => s.setEasyConnect);
  const mapOptionsOpen = useMapStore((s) => s.mapOptionsOpen);
  const setMapOptionsOpen = useMapStore((s) => s.setMapOptionsOpen);
  const edgeStyle = useMapStore((s) => s.edgeStyle);
  const setEdgeStyle = useMapStore((s) => s.setEdgeStyle);
  const connectionThickness = useMapStore((s) => s.connectionThickness);
  const setConnectionThickness = useMapStore((s) => s.setConnectionThickness);
  const routeMode = useMapStore((s) => s.routeMode);
  const setRouteMode = useMapStore((s) => s.setRouteMode);
  const uiZoom = useMapStore((s) => s.uiZoom);
  const setUiZoom = useMapStore((s) => s.setUiZoom);
  const updateConnection = useMapStore((s) => s.updateConnection);
  const requestAutoLayout = useMapStore((s) => s.requestAutoLayout);
  const connectionCount = useMapStore((s) => s.map.connections.length);
  const systemCount = useMapStore((s) => s.map.systems.length);

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
      if (
        conn.sourceHandle !== sourceHandle ||
        conn.targetHandle !== targetHandle
      ) {
        updateConnection(conn.id, { sourceHandle, targetHandle });
      }
    }
  }

  function handleExport() {
    const { map } = useMapStore.getState();
    const json = JSON.stringify(map, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${map.name.replace(/[^a-z0-9]/gi, "_")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(file: File) {
    let parsed: WormholeMap;
    try {
      parsed = JSON.parse(await file.text()) as WormholeMap;
    } catch {
      toast.error("Invalid JSON file.");
      return;
    }
    if (!parsed.systems || !parsed.connections) {
      toast.error("File does not look like a Eve-Nexum map export.");
      return;
    }
    try {
      const { id } = await api<{ id: string }>("/api/maps/import", {
        method: "POST",
        body: JSON.stringify({
          name: parsed.name,
          systems: parsed.systems,
          connections: parsed.connections,
        }),
      });
      await useMapStore.getState().loadMaps();
      await useMapStore.getState().switchMap(id);
    } catch (err) {
      toast.error(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return (
    <div className={`map-sidebar${mapOptionsOpen ? " map-sidebar--open" : ""}`}>
      <button
        className="map-sidebar__tab"
        onClick={() => setMapOptionsOpen(!mapOptionsOpen)}
        title={mapOptionsOpen ? "Close map options" : "Map options"}
      >
        {mapOptionsOpen ? (
          <CaretRightIcon size={14} weight="bold" />
        ) : (
          <CaretLeftIcon size={14} weight="bold" />
        )}
      </button>

      <div className="map-sidebar__content">
        <CollapsibleSection title="Map Options" {...sectionProps("mapOptions")}>
          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Snap to Grid</label>
            <button
              className={`toolbar__toggle${snapToGrid ? " toolbar__toggle--on" : ""}`}
              onClick={() => setSnapToGrid(!snapToGrid)}
              aria-pressed={snapToGrid}
            >
              {snapToGrid ? "On" : "Off"}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Minimap</label>
            <button
              className={`toolbar__toggle${showMinimap ? " toolbar__toggle--on" : ""}`}
              onClick={() => setShowMinimap(!showMinimap)}
              aria-pressed={showMinimap}
            >
              {showMinimap ? "On" : "Off"}
            </button>
          </div>

          {showMinimap && (
            <div className="map-sidebar__row">
              <label className="map-sidebar__label" htmlFor="minimap-position">
                Position
              </label>
              <select
                id="minimap-position"
                className="map-sidebar__select"
                value={minimapPosition}
                onChange={(e) =>
                  setMinimapPosition(e.target.value as MinimapPosition)
                }
              >
                <option value="bottom-right">Bottom right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="top-right">Top right</option>
                <option value="top-left">Top left</option>
              </select>
            </div>
          )}

          <div className="map-sidebar__row">
            <label className="map-sidebar__label" htmlFor="ui-zoom">
              Font Size
            </label>
            <div className="map-sidebar__zoom">
              <input
                id="ui-zoom"
                type="range"
                min={0.8}
                max={1.5}
                step={0.05}
                value={uiZoom}
                onChange={(e) => setUiZoom(parseFloat(e.target.value))}
                className="map-sidebar__zoom-slider"
              />
              <button
                type="button"
                className="map-sidebar__zoom-value"
                onClick={() => setUiZoom(1)}
                title="Reset to 100%"
              >
                {Math.round(uiZoom * 100)}%
              </button>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title="System Options"
          {...sectionProps("systemOptions")}
        >
          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Compact</label>
            <button
              className={`toolbar__toggle${compactMode ? " toolbar__toggle--on" : ""}`}
              onClick={() => setCompactMode(!compactMode)}
              aria-pressed={compactMode}
            >
              {compactMode ? "On" : "Off"}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Uniform Size</label>
            <button
              className={`toolbar__toggle${uniformSize ? " toolbar__toggle--on" : ""}`}
              onClick={() => setUniformSize(!uniformSize)}
              aria-pressed={uniformSize}
            >
              {uniformSize ? "On" : "Off"}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Show Static WHs</label>
            <button
              className={`toolbar__toggle${showStatics ? " toolbar__toggle--on" : ""}`}
              onClick={() => setShowStatics(!showStatics)}
              aria-pressed={showStatics}
            >
              {showStatics ? "On" : "Off"}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">Easy Connect</label>
            <button
              className={`toolbar__toggle${easyConnect ? " toolbar__toggle--on" : ""}`}
              onClick={() => setEasyConnect(!easyConnect)}
              aria-pressed={easyConnect}
            >
              {easyConnect ? "On" : "Off"}
            </button>
          </div>

          <CustomIntelBlock />
        </CollapsibleSection>

        <CollapsibleSection
          title="Connections"
          {...sectionProps("connections")}
        >
          <div className="map-sidebar__label">Connection Style</div>
          <div className="map-sidebar__btn-group">
            {(
              [
                { value: "bezier", label: "Standard" },
                { value: "straight", label: "Straight" },
                { value: "smoothstep", label: "Step" },
              ] as const
            ).map(({ value, label }) => (
              <button
                key={value}
                className={`map-sidebar__btn-group-item${edgeStyle === value ? " map-sidebar__btn-group-item--active" : ""}`}
                onClick={() => setEdgeStyle(value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="map-sidebar__row">
            <label
              className="map-sidebar__label"
              htmlFor="connection-thickness"
            >
              Connection Thickness
            </label>
            <select
              id="connection-thickness"
              className="map-sidebar__select"
              value={connectionThickness}
              onChange={(e) =>
                setConnectionThickness(
                  e.target.value as "thin" | "standard" | "thick" | "extra",
                )
              }
            >
              <option value="thin">Thin</option>
              <option value="standard">Standard</option>
              <option value="thick">Thick</option>
              <option value="extra">Extra Thick</option>
            </select>
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

        <CollapsibleSection title="Route" {...sectionProps("route")}>
          <div className="map-sidebar__row">
            <label className="map-sidebar__label" htmlFor="route-mode">
              Route Preference
            </label>
            <select
              id="route-mode"
              className="map-sidebar__select"
              value={routeMode}
              onChange={(e) =>
                setRouteMode(e.target.value as "shortest" | "secure")
              }
            >
              <option value="shortest">Shortest</option>
              <option value="secure">Secure</option>
            </select>
          </div>
          <p className="map-sidebar__hint">
            Shortest: fewest jumps regardless of security. Secure: prefer
            high-sec, detour through low/null only when no high-sec path is
            available.
          </p>
        </CollapsibleSection>

        <CollapsibleSection
          title="Chain Exits"
          {...sectionProps("chainExits")}
        >
          <ChainExitsSection />
        </CollapsibleSection>

        <CollapsibleSection
          title="Proximity Alerts"
          {...sectionProps("proximityAlerts")}
        >
          <div className="map-sidebar__hint">
            Ping when an incursion, insurgency, or hostile-sov system is within
            range of your current location.
          </div>
          <div className="map-sidebar__row">
            <label className="map-sidebar__label" htmlFor="proximity-threshold">
              Threshold
            </label>
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
            {notifPermission === "granted" ? (
              <span className="map-sidebar__status map-sidebar__status--ok">
                Enabled
              </span>
            ) : notifPermission === "denied" ? (
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
          {notifPermission === "denied" && (
            <div className="map-sidebar__hint">
              Browser is blocking notifications for this site. Click the lock
              icon in your address bar → Notifications → Allow → reload the
              page.
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection title="Activity" {...sectionProps("activity")}>
          <div className="map-sidebar__hint">
            Show graphs for the following:
          </div>
          <SettingToggle settingKey="nexum.activity.showJumps" label="Jumps" />
          <SettingToggle
            settingKey="nexum.activity.showShipKills"
            label="Ship Kills"
          />
          <SettingToggle
            settingKey="nexum.activity.showPodKills"
            label="Pod Kills"
          />
          <SettingToggle
            settingKey="nexum.activity.showNpcKills"
            label="NPC Kills"
          />
          <SettingToggle
            settingKey="nexum.activity.showNpcDelta"
            label="NPC Delta"
          />
        </CollapsibleSection>

        <CollapsibleSection title="Fleet" {...sectionProps("fleet")}>
          <div className="map-sidebar__hint">
            Render fleet-mates as purple dots on the system they're in. Hover a
            dot to see the names.
          </div>
          <SettingToggle
            settingKey="nexum.fleet.showMembers"
            label="Show fleet members"
          />
        </CollapsibleSection>

        {!hideTopologyTools && (
          <CollapsibleSection
            title="Stale System Fade"
            {...sectionProps("staleFade")}
          >
            <div className="map-sidebar__hint">
              Visually dim systems that haven't been updated for the chosen
              interval, so old chain residue is easy to spot at a glance.
            </div>
            <div className="map-sidebar__row">
              <label className="map-sidebar__label" htmlFor="stale-threshold">
                Threshold
              </label>
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
          <CollapsibleSection title="Export" {...sectionProps("export")}>
            <div className="map-sidebar__section">
              <button className="map-sidebar__action" onClick={handleExport}>
                ↓ Export as JSON
              </button>

              <div
                className={`map-sidebar__import-wrap${atMapLimit ? " map-sidebar__import-wrap--disabled" : ""}`}
              >
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

        {canShareThisMap(user, isCorpMap, isMapOwner) && (
          <CollapsibleSection
            title="Live Map Sharing"
            {...sectionProps("share")}
          >
            <ShareSection />
          </CollapsibleSection>
        )}

        {canManageShareGrants && (
          <CollapsibleSection
            title="Share Map"
            {...sectionProps("shareGrants")}
          >
            <MapSharesSection />
          </CollapsibleSection>
        )}

        <CollapsibleSection title="Shortcuts" {...sectionProps("shortcuts")}>
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
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImport(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
