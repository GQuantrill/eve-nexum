import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  useNotificationPermission,
  notifyPermissionChanged,
} from "../../hooks/useNotificationPermission";
import { expiresIn } from "../../i18n/format";
import { useMapStore } from "../../store/mapStore";
import { useAuth } from "../../context/AuthContext";
import { api } from "../../api/client";
import { toast } from "./Toaster";
import { useProximityThreshold } from "../../hooks/useProximityAlerts";
import { useStaleThreshold } from "../../hooks/useStaleThreshold";
import {
  useMinimapPosition,
  type MinimapPosition,
} from "../../hooks/useMinimapPosition";
import { useUserSetting } from "../../hooks/useUserSetting";
import { normalizePlacement } from "../../hooks/useLocationTracking";
import { NOTIFY } from "../../utils/notificationPrefs";
import { useResettableState } from "../../hooks/useResettableState";
import { DEFAULT_BOOKMARK_FORMAT, BOOKMARK_TOKENS } from "../../utils/signatureBookmark";
import { toPng } from "html-to-image";
import { CaretLeftIcon, CaretRightIcon, GearIcon } from "@phosphor-icons/react";
import { ChainExitsSection } from "./ChainExitsSection";
import { MapSharesSection } from "./MapSharesSection";
import { MergeMapModal } from "./MergeMapModal";
import { CustomIntelBlock } from "./CustomIntelBlock";
import { ContentFilterBlock } from "./ContentFilterBlock";
import { useIsMapOwner } from "../../hooks/useIsMapOwner";
import type { WormholeMap } from "../../types";

// Single labelled checkbox row backed by useUserSetting so the on/off
// state syncs cross-device via users.ui_settings. Used by the Activity
// and Fleet sections — anywhere a section needs a row of plain on/off
// flags, this is the building block.
function SettingToggle({
  settingKey,
  label,
  defaultOn = true,
}: {
  settingKey: string;
  label: string;
  defaultOn?: boolean;
}) {
  const [enabled, setEnabled] = useUserSetting<boolean>(settingKey, defaultOn);
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

// One event row in the Notifications grid: an event label with independent
// desktop + sound checkboxes, each backed by its own ui_settings key.
function NotifRow({
  label, desktopKey, soundKey, desktopDefault = true, soundDefault = true,
}: {
  label: string;
  desktopKey: string;
  soundKey: string;
  desktopDefault?: boolean;
  soundDefault?: boolean;
}) {
  const [desktop, setDesktop] = useUserSetting<boolean>(desktopKey, desktopDefault);
  const [sound, setSound]     = useUserSetting<boolean>(soundKey, soundDefault);
  return (
    <div className="notif-grid__row">
      <span className="notif-grid__label">{label}</span>
      <input
        type="checkbox"
        className="map-sidebar__toggle-input"
        checked={desktop}
        onChange={(e) => setDesktop(e.target.checked)}
        aria-label={`${label} — desktop`}
      />
      <input
        type="checkbox"
        className="map-sidebar__toggle-input"
        checked={sound}
        onChange={(e) => setSound(e.target.checked)}
        aria-label={`${label} — sound`}
      />
    </div>
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
  | "wormholeBookmarks"
  | "mapControls"
  | "systemOptions"
  | "contentFilter"
  | "connections"
  | "route"
  | "chainExits"
  | "proximityAlerts"
  | "notifications"
  | "activity"
  | "fleet"
  | "share"
  | "shareGrants"
  | "mergeMaps"
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
const SHARE_EXPIRY_OPTIONS: Array<{ hours: number; label: (t: TFunction) => string }> = [
  { hours: 1, label: (t) => t("units.hours", { count: 1 }) },
  { hours: 12, label: (t) => t("units.hours", { count: 12 }) },
  { hours: 24, label: (t) => t("units.days", { count: 1 }) },
  { hours: 72, label: (t) => t("units.days", { count: 3 }) },
  { hours: 168, label: (t) => t("units.weeks", { count: 1 }) },
];
const SHARE_EXPIRY_DEFAULT = 24;

function ShareSection() {
  const { t } = useTranslation();
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
  // These mirror the map's persisted share flags but are user-toggleable, so
  // they reset to the effective value whenever the map's flags change (link
  // created/changed) — via render-phase adjustment, not a syncing effect.
  const [includeSigs, setIncludeSigs] = useResettableState(effectiveSigs);
  const [includeBridges, setIncludeBridges] = useResettableState(effectiveBridges);
  const [includeNotes, setIncludeNotes] = useResettableState(effectiveNotes);
  const [includeStructures, setIncludeStructures] = useResettableState(effectiveStructures);
  // Expiry is generation-time only — it doesn't sync from the map state
  // because once a link exists its expiry is just shown as a countdown.
  const [expiryHours, setExpiryHours] = useState<number>(SHARE_EXPIRY_DEFAULT);

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
      setError(e instanceof Error ? e.message : t("mapSidebar.createShareFailed"));
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
      setError(e instanceof Error ? e.message : t("mapSidebar.revokeShareFailed"));
    } finally {
      setBusy(false);
    }
  }

  function copyUrl() {
    if (!url) return;
    navigator.clipboard.writeText(url).then(
      () => toast.success(t("mapSidebar.linkCopied")),
      () => toast.error(t("mapSidebar.copyFailed")),
    );
  }

  function formatRemaining(): string {
    return expiresIn(t, expiresAt - now);
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
        e instanceof Error ? e.message : t("mapSidebar.updateShareFailed"),
      );
    }
  }

  return (
    <>
      <div className="map-sidebar__hint">
        {isActive
          ? t("mapSidebar.shareActiveHint")
          : t("mapSidebar.shareInactiveHint")}
      </div>

      {!isActive && (
        <div className="map-sidebar__row">
          <label className="map-sidebar__label" htmlFor="share-expiry">
            {t("mapSidebar.linkExpiresAfter")}
          </label>
          <select
            id="share-expiry"
            className="map-sidebar__select"
            value={expiryHours}
            onChange={(e) => setExpiryHours(parseInt(e.target.value, 10))}
          >
            {SHARE_EXPIRY_OPTIONS.map((o) => (
              <option key={o.hours} value={o.hours}>
                {o.label(t)}
              </option>
            ))}
          </select>
        </div>
      )}

      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">{t("mapSidebar.includeSignatures")}</span>
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={includeSigs}
          onChange={(e) => applyToggle({ includeSigs: e.target.checked })}
        />
      </label>
      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">{t("mapSidebar.showJumpBridges")}</span>
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={includeBridges}
          onChange={(e) => applyToggle({ includeBridges: e.target.checked })}
        />
      </label>
      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">{t("mapSidebar.includeStructures")}</span>
        <input
          type="checkbox"
          className="map-sidebar__toggle-input"
          checked={includeStructures}
          onChange={(e) => applyToggle({ includeStructures: e.target.checked })}
        />
      </label>
      <label className="map-sidebar__row map-sidebar__toggle-row">
        <span className="map-sidebar__label">{t("mapSidebar.includeNotes")}</span>
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
            {t("mapSidebar.copyLink")}
          </button>
          <button
            className="map-sidebar__action"
            onClick={revoke}
            disabled={busy}
          >
            {busy ? t("mapSidebar.working") : t("mapSidebar.revoke")}
          </button>
        </>
      ) : (
        <button
          className="map-sidebar__action"
          onClick={generate}
          disabled={busy}
        >
          {busy ? t("mapSidebar.working") : t("mapSidebar.createShareLink")}
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

// Merge entry point. Opens the merge modal, and — for full/admin members
// looking at a corp map — exposes the "allow as merge source" opt-in that
// lets that corp map be used as a merge source by the corp.
function MergeSection() {
  const { t } = useTranslation();
  const map = useMapStore((s) => s.map);
  const mapCount = useMapStore((s) => s.maps.length);
  const { user } = useAuth();
  const role = user?.role ?? "readonly";
  const isCorpMap = !!map.isCorpMap;
  const canToggleSource = isCorpMap && (role === "full" || role === "admin");

  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // Read straight from the store (no mirrored local state) so switching maps
  // always shows the right value, and toggle optimistically + revert on error.
  const allowSource = !!map.allowAsMergeSource;
  const allowDestination = !!map.allowAsMergeDestination;

  function setFlagInStore(field: "allowAsMergeSource" | "allowAsMergeDestination", value: boolean) {
    useMapStore.setState((s) => ({
      map: { ...s.map, [field]: value },
      maps: s.maps.map((m) => (m.id === map.id ? { ...m, [field]: value } : m)),
    }));
  }

  async function toggleFlag(field: "allowAsMergeSource" | "allowAsMergeDestination", next: boolean) {
    setSaving(true);
    setFlagInStore(field, next);
    try {
      await api(`/api/maps/${map.id}`, {
        method: "PATCH",
        body: JSON.stringify({ [field]: next }),
      });
    } catch (e) {
      setFlagInStore(field, !next);
      toast.error(e instanceof Error ? e.message : t("mapSidebar.updateSettingFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="map-sidebar__hint">
        {t("mapSidebar.mergeHint")}
      </div>
      <button
        className="map-sidebar__action"
        onClick={() => setOpen(true)}
        disabled={mapCount < 2}
      >
        {t("mapSidebar.mergeButton")}
      </button>

      {canToggleSource && (
        <>
          <label className="map-sidebar__row map-sidebar__toggle-row">
            <span className="map-sidebar__label">{t("mapSidebar.allowMergeSource")}</span>
            <input
              type="checkbox"
              className="map-sidebar__toggle-input"
              checked={allowSource}
              disabled={saving}
              onChange={(e) => toggleFlag("allowAsMergeSource", e.target.checked)}
            />
          </label>
          <label className="map-sidebar__row map-sidebar__toggle-row">
            <span className="map-sidebar__label">{t("mapSidebar.allowMergeDest")}</span>
            <input
              type="checkbox"
              className="map-sidebar__toggle-input"
              checked={allowDestination}
              disabled={saving}
              onChange={(e) => toggleFlag("allowAsMergeDestination", e.target.checked)}
            />
          </label>
          <div className="map-sidebar__hint">
            <Trans i18nKey="mapSidebar.mergeFlagHint" />
          </div>
        </>
      )}

      {open && <MergeMapModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function MapSidebar() {
  const { t } = useTranslation();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [threshold, setThreshold] = useProximityThreshold();
  const [staleHours, setStaleHours] = useStaleThreshold();
  // Single source of truth for which section is expanded. Defaults to
  // Map Options so first-load users see something useful immediately.
  const [openSection, setOpenSection] = useUserSetting<SectionId>(
    "nexum.mapSidebar.openSection",
    "mapControls",
  );
  const sectionProps = (id: SectionId) => ({
    isOpen: openSection === id,
    onToggle: () => setOpenSection((cur) => (cur === id ? null : id)),
  });
  // Preferences live in a Settings dialog (gear button) rather than crowding
  // the sidebar; the sidebar keeps only the live mapping tools.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"display" | "signatures" | "shortcuts">("display");
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
      toast.error(t("mapSidebar.canvasNotFound"));
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
        t("mapSidebar.exportFailed", { error: err instanceof Error ? err.message : String(err) }),
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
  const [placement, setPlacement] = useUserSetting<string>("nexum.map.placement", "east");
  const [sigBookmarkFmt, setSigBookmarkFmt] = useUserSetting<string>("nexum.sig.bookmarkFormat", DEFAULT_BOOKMARK_FORMAT);
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
  const optimizeConnections = useMapStore((s) => s.optimizeConnections);
  const requestAutoLayout = useMapStore((s) => s.requestAutoLayout);
  const connectionCount = useMapStore((s) => s.map.connections.length);
  const systemCount = useMapStore((s) => s.map.systems.length);

  const atMapLimit = maps.length >= maxMaps;


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
      toast.error(t("mapSidebar.invalidJson"));
      return;
    }
    if (!parsed.systems || !parsed.connections) {
      toast.error(t("mapSidebar.notNexumMap"));
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
        t("mapSidebar.importFailed", { error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }

  return (
    <div className={`map-sidebar${mapOptionsOpen ? " map-sidebar--open" : ""}`}>
      <button
        className="map-sidebar__tab"
        onClick={() => setMapOptionsOpen(!mapOptionsOpen)}
        title={mapOptionsOpen ? t("mapSidebar.closeOptions") : t("mapSidebar.openOptions")}
      >
        {mapOptionsOpen ? (
          <CaretRightIcon size={14} weight="bold" />
        ) : (
          <CaretLeftIcon size={14} weight="bold" />
        )}
      </button>

      <div className="map-sidebar__content">
        <button
          type="button"
          className="map-sidebar__settings-btn"
          onClick={() => setSettingsOpen(true)}
        >
          <GearIcon size={14} weight="bold" />
          {t("mapSidebar.settings")}
        </button>

        <CollapsibleSection title={t("mapSidebar.sections.mapControls")} {...sectionProps("mapControls")}>
          <SettingToggle
            settingKey="nexum.map.invertZoom"
            label={t("mapSidebar.invertZoom")}
            defaultOn={false}
          />
          <SettingToggle
            settingKey="nexum.crossMapSync"
            label={t("mapSidebar.crossMapSync")}
            defaultOn={false}
          />
          <p className="map-sidebar__help">{t("mapSidebar.crossMapSyncHelp")}</p>
        </CollapsibleSection>

        <CollapsibleSection
          title={t("mapSidebar.sections.systemOptions")}
          {...sectionProps("systemOptions")}
        >
          <div className="map-sidebar__row">
            <label className="map-sidebar__label">{t("mapSidebar.compact")}</label>
            <button
              className={`toolbar__toggle${compactMode ? " toolbar__toggle--on" : ""}`}
              onClick={() => setCompactMode(!compactMode)}
              aria-pressed={compactMode}
            >
              {compactMode ? t("actions.on") : t("actions.off")}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">{t("mapSidebar.uniformSize")}</label>
            <button
              className={`toolbar__toggle${uniformSize ? " toolbar__toggle--on" : ""}`}
              onClick={() => setUniformSize(!uniformSize)}
              aria-pressed={uniformSize}
            >
              {uniformSize ? t("actions.on") : t("actions.off")}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">{t("mapSidebar.showStaticWhs")}</label>
            <button
              className={`toolbar__toggle${showStatics ? " toolbar__toggle--on" : ""}`}
              onClick={() => setShowStatics(!showStatics)}
              aria-pressed={showStatics}
            >
              {showStatics ? t("actions.on") : t("actions.off")}
            </button>
          </div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">{t("mapSidebar.easyConnect")}</label>
            <button
              className={`toolbar__toggle${easyConnect ? " toolbar__toggle--on" : ""}`}
              onClick={() => setEasyConnect(!easyConnect)}
              aria-pressed={easyConnect}
            >
              {easyConnect ? t("actions.on") : t("actions.off")}
            </button>
          </div>

          <CustomIntelBlock />
        </CollapsibleSection>

        <CollapsibleSection
          title={t("mapSidebar.sections.contentFilter")}
          {...sectionProps("contentFilter")}
        >
          <ContentFilterBlock />
        </CollapsibleSection>

        <CollapsibleSection
          title={t("mapSidebar.sections.connections")}
          {...sectionProps("connections")}
        >
          <div className="map-sidebar__label">{t("mapSidebar.connectionStyle")}</div>
          <div className="map-sidebar__btn-group">
            {(
              [
                { value: "bezier", label: t("mapSidebar.edgeStyle.bezier") },
                { value: "straight", label: t("mapSidebar.edgeStyle.straight") },
                { value: "smoothstep", label: t("mapSidebar.edgeStyle.smoothstep") },
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
              {t("mapSidebar.connectionThickness")}
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
              <option value="thin">{t("mapSidebar.thickness.thin")}</option>
              <option value="standard">{t("mapSidebar.thickness.standard")}</option>
              <option value="thick">{t("mapSidebar.thickness.thick")}</option>
              <option value="extra">{t("mapSidebar.thickness.extra")}</option>
            </select>
          </div>

          {!hideTopologyTools && (
            <>
              <button
                className="map-sidebar__action"
                onClick={optimizeConnections}
                disabled={connectionCount === 0}
              >
                {t("mapSidebar.optimizeConnections")}
              </button>
              <button
                className="map-sidebar__action"
                onClick={requestAutoLayout}
                disabled={systemCount < 2}
                data-tooltip={t("mapSidebar.spreadNodesTooltip")}
              >
                {t("mapSidebar.spreadNodes")}
              </button>
            </>
          )}
        </CollapsibleSection>

        <CollapsibleSection title={t("mapSidebar.sections.route")} {...sectionProps("route")}>
          <div className="map-sidebar__row">
            <label className="map-sidebar__label" htmlFor="route-mode">
              {t("mapSidebar.routePreference")}
            </label>
            <select
              id="route-mode"
              className="map-sidebar__select"
              value={routeMode}
              onChange={(e) =>
                setRouteMode(e.target.value as "shortest" | "secure")
              }
            >
              <option value="shortest">{t("mapSidebar.routeShortest")}</option>
              <option value="secure">{t("mapSidebar.routeSecure")}</option>
            </select>
          </div>
          <p className="map-sidebar__hint">
            {t("mapSidebar.routeHint")}
          </p>
        </CollapsibleSection>

        <CollapsibleSection
          title={t("mapSidebar.sections.chainExits")}
          {...sectionProps("chainExits")}
        >
          <ChainExitsSection />
        </CollapsibleSection>

        <CollapsibleSection
          title={t("mapSidebar.sections.proximityAlerts")}
          {...sectionProps("proximityAlerts")}
        >
          <div className="map-sidebar__hint">
            {t("mapSidebar.proximityHint")}
          </div>
          <div className="map-sidebar__row">
            <label className="map-sidebar__label" htmlFor="proximity-threshold">
              {t("mapSidebar.threshold")}
            </label>
            <select
              id="proximity-threshold"
              className="map-sidebar__select"
              value={threshold}
              onChange={(e) => setThreshold(parseInt(e.target.value, 10))}
            >
              <option value={0}>{t("mapSidebar.proximityInSystem")}</option>
              <option value={1}>{t("mapSidebar.proximityLe", { count: 1 })}</option>
              <option value={2}>{t("mapSidebar.proximityLe", { count: 2 })}</option>
              <option value={3}>{t("mapSidebar.proximityLe", { count: 3 })}</option>
              <option value={4}>{t("mapSidebar.proximityLe", { count: 4 })}</option>
              <option value={5}>{t("mapSidebar.proximityLe", { count: 5 })}</option>
            </select>
          </div>
          <div className="map-sidebar__hint">
            {t("mapSidebar.proximityNotifyHint")}
          </div>
        </CollapsibleSection>

        <CollapsibleSection
          title={t("mapSidebar.sections.notifications")}
          {...sectionProps("notifications")}
        >
          <div className="map-sidebar__hint">{t("mapSidebar.notifHint")}</div>

          <div className="map-sidebar__row">
            <label className="map-sidebar__label">{t("mapSidebar.browserNotifications")}</label>
            {notifPermission === "granted" ? (
              <span className="map-sidebar__status map-sidebar__status--ok">
                {t("mapSidebar.notifEnabled")}
              </span>
            ) : notifPermission === "denied" ? (
              <span
                className="map-sidebar__status map-sidebar__status--err"
                data-tooltip={t("mapSidebar.notifBlockedTooltip")}
              >
                {t("mapSidebar.notifBlocked")}
              </span>
            ) : (
              <button
                type="button"
                className="toolbar__toggle"
                onClick={requestNotifPermission}
              >
                {t("mapSidebar.notifEnable")}
              </button>
            )}
          </div>
          {notifPermission === "denied" && (
            <div className="map-sidebar__hint">{t("mapSidebar.notifBlockedHint")}</div>
          )}

          <div className="notif-grid">
            <div className="notif-grid__head">
              <span />
              <span>{t("mapSidebar.notifColDesktop")}</span>
              <span>{t("mapSidebar.notifColSound")}</span>
            </div>
            <NotifRow
              label={t("mapSidebar.notifK162")}
              desktopKey={NOTIFY.k162Desktop}
              soundKey={NOTIFY.k162Sound}
            />
            <NotifRow
              label={t("mapSidebar.notifProximity")}
              desktopKey={NOTIFY.proximityDesktop}
              soundKey={NOTIFY.proximitySound}
            />
            <NotifRow
              label={t("mapSidebar.notifWatchlist")}
              desktopKey={NOTIFY.watchlistDesktop}
              soundKey={NOTIFY.watchlistSound}
              desktopDefault={false}
            />
          </div>
        </CollapsibleSection>

        <CollapsibleSection title={t("mapSidebar.sections.activity")} {...sectionProps("activity")}>
          <div className="map-sidebar__hint">
            {t("mapSidebar.activityHint")}
          </div>
          <SettingToggle settingKey="nexum.activity.showJumps" label={t("mapSidebar.activityJumps")} />
          <SettingToggle
            settingKey="nexum.activity.showShipKills"
            label={t("mapSidebar.activityShipKills")}
          />
          <SettingToggle
            settingKey="nexum.activity.showPodKills"
            label={t("mapSidebar.activityPodKills")}
          />
          <SettingToggle
            settingKey="nexum.activity.showNpcKills"
            label={t("mapSidebar.activityNpcKills")}
          />
          <SettingToggle
            settingKey="nexum.activity.showNpcDelta"
            label={t("mapSidebar.activityNpcDelta")}
          />
        </CollapsibleSection>

        <CollapsibleSection title={t("mapSidebar.sections.fleet")} {...sectionProps("fleet")}>
          <div className="map-sidebar__hint">
            {t("mapSidebar.fleetHint")}
          </div>
          <SettingToggle
            settingKey="nexum.fleet.showMembers"
            label={t("mapSidebar.showFleetMembers")}
          />
          <SettingToggle
            settingKey="nexum.account.showOnMap"
            label={t("mapSidebar.showAccountChars")}
          />
        </CollapsibleSection>

        {!hideTopologyTools && (
          <CollapsibleSection
            title={t("mapSidebar.sections.staleFade")}
            {...sectionProps("staleFade")}
          >
            <div className="map-sidebar__hint">
              {t("mapSidebar.staleHint")}
            </div>
            <div className="map-sidebar__row">
              <label className="map-sidebar__label" htmlFor="stale-threshold">
                {t("mapSidebar.threshold")}
              </label>
              <select
                id="stale-threshold"
                className="map-sidebar__select"
                value={staleHours}
                onChange={(e) => setStaleHours(parseInt(e.target.value, 10))}
              >
                <option value={1}>{t("units.hours", { count: 1 })}</option>
                <option value={4}>{t("units.hours", { count: 4 })}</option>
                <option value={12}>{t("units.hours", { count: 12 })}</option>
                <option value={24}>{t("units.hours", { count: 24 })}</option>
                <option value={48}>{t("units.hours", { count: 48 })}</option>
                <option value={168}>{t("units.weeks", { count: 1 })}</option>
                <option value={720}>{t("units.months", { count: 1 })}</option>
              </select>
            </div>
          </CollapsibleSection>
        )}

        {!hideTopologyTools && (
          <CollapsibleSection title={t("mapSidebar.sections.importExport")} {...sectionProps("export")}>
            <div className="map-sidebar__section">
              <button className="map-sidebar__action" onClick={handleExport}>
                {t("mapSidebar.exportJson")}
              </button>

              <div
                className={`map-sidebar__import-wrap${atMapLimit ? " map-sidebar__import-wrap--disabled" : ""}`}
              >
                <button
                  className="map-sidebar__action"
                  onClick={() => importInputRef.current?.click()}
                  disabled={atMapLimit}
                >
                  {t("mapSidebar.importJson")}
                </button>
              </div>
              <button
                type="button"
                className="map-sidebar__action"
                onClick={handleExportPng}
                disabled={systemCount === 0}
              >
                {t("mapSidebar.exportPng")}
              </button>
            </div>
          </CollapsibleSection>
        )}

        <CollapsibleSection title={t("mapSidebar.sections.mergeMaps")} {...sectionProps("mergeMaps")}>
          <MergeSection />
        </CollapsibleSection>

        {canShareThisMap(user, isCorpMap, isMapOwner) && (
          <CollapsibleSection
            title={t("mapSidebar.sections.liveSharing")}
            {...sectionProps("share")}
          >
            <ShareSection />
          </CollapsibleSection>
        )}

        {canManageShareGrants && (
          <CollapsibleSection
            title={t("mapSidebar.sections.shareMap")}
            {...sectionProps("shareGrants")}
          >
            <MapSharesSection />
          </CollapsibleSection>
        )}

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

      {settingsOpen && createPortal(
        <div className="settings-modal__overlay" onClick={() => setSettingsOpen(false)}>
          <div className="settings-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="settings-modal__head">
              <h2 className="settings-modal__title">{t("mapSidebar.settings")}</h2>
              <button type="button" className="icon-btn" onClick={() => setSettingsOpen(false)} title={t("actions.close")}>✕</button>
            </div>

            <div className="settings-modal__tabs">
              <button type="button" className={`settings-modal__tab${settingsTab === "display" ? " settings-modal__tab--active" : ""}`} onClick={() => setSettingsTab("display")}>
                {t("mapSidebar.sections.mapOptions")}
              </button>
              <button type="button" className={`settings-modal__tab${settingsTab === "signatures" ? " settings-modal__tab--active" : ""}`} onClick={() => setSettingsTab("signatures")}>
                {t("mapSidebar.sections.wormholeBookmarks")}
              </button>
              <button type="button" className={`settings-modal__tab${settingsTab === "shortcuts" ? " settings-modal__tab--active" : ""}`} onClick={() => setSettingsTab("shortcuts")}>
                {t("mapSidebar.sections.shortcuts")}
              </button>
            </div>

            <div className="settings-modal__body">
              {settingsTab === "display" && (
                <>
                  <div className="map-sidebar__row">
                    <label className="map-sidebar__label">{t("mapSidebar.snapToGrid")}</label>
                    <button className={`toolbar__toggle${snapToGrid ? " toolbar__toggle--on" : ""}`} onClick={() => setSnapToGrid(!snapToGrid)} aria-pressed={snapToGrid}>
                      {snapToGrid ? t("actions.on") : t("actions.off")}
                    </button>
                  </div>
                  <div className="map-sidebar__row">
                    <label className="map-sidebar__label">{t("mapSidebar.minimap")}</label>
                    <button className={`toolbar__toggle${showMinimap ? " toolbar__toggle--on" : ""}`} onClick={() => setShowMinimap(!showMinimap)} aria-pressed={showMinimap}>
                      {showMinimap ? t("actions.on") : t("actions.off")}
                    </button>
                  </div>
                  {showMinimap && (
                    <div className="map-sidebar__row">
                      <label className="map-sidebar__label" htmlFor="minimap-position">{t("mapSidebar.position")}</label>
                      <select id="minimap-position" className="map-sidebar__select" value={minimapPosition} onChange={(e) => setMinimapPosition(e.target.value as MinimapPosition)}>
                        <option value="bottom-right">{t("mapSidebar.minimapPos.bottomRight")}</option>
                        <option value="bottom-left">{t("mapSidebar.minimapPos.bottomLeft")}</option>
                        <option value="top-right">{t("mapSidebar.minimapPos.topRight")}</option>
                        <option value="top-left">{t("mapSidebar.minimapPos.topLeft")}</option>
                      </select>
                    </div>
                  )}
                  <div className="map-sidebar__row">
                    <label className="map-sidebar__label" htmlFor="ui-zoom">{t("mapSidebar.fontSize")}</label>
                    <div className="map-sidebar__zoom">
                      <input id="ui-zoom" type="range" min={0.8} max={1.5} step={0.05} value={uiZoom} onChange={(e) => setUiZoom(parseFloat(e.target.value))} className="map-sidebar__zoom-slider" />
                      <button type="button" className="map-sidebar__zoom-value" onClick={() => setUiZoom(1)} title={t("mapSidebar.resetZoom")}>
                        {Math.round(uiZoom * 100)}%
                      </button>
                    </div>
                  </div>
                  <div className="map-sidebar__row">
                    <label className="map-sidebar__label" htmlFor="placement-dir">{t("mapSidebar.placement")}</label>
                    <select id="placement-dir" className="map-sidebar__select" value={normalizePlacement(placement)} onChange={(e) => setPlacement(e.target.value)}>
                      <option value="east">{t("mapSidebar.placementOptions.east")}</option>
                      <option value="south">{t("mapSidebar.placementOptions.south")}</option>
                      <option value="west">{t("mapSidebar.placementOptions.west")}</option>
                      <option value="north">{t("mapSidebar.placementOptions.north")}</option>
                    </select>
                  </div>
                </>
              )}

              {settingsTab === "signatures" && (
                <>
                  <div className="map-sidebar__field">
                    <label className="map-sidebar__label" htmlFor="sig-bookmark-fmt">{t("mapSidebar.sigBookmark")}</label>
                    <input id="sig-bookmark-fmt" className="map-sidebar__select map-sidebar__select--full" type="text" spellCheck={false} value={sigBookmarkFmt} onChange={(e) => setSigBookmarkFmt(e.target.value)} placeholder={DEFAULT_BOOKMARK_FORMAT} />
                  </div>
                  <p className="map-sidebar__help">{t("mapSidebar.bookmarkHelp")}</p>
                  <ul className="map-sidebar__tokens">
                    {BOOKMARK_TOKENS.map((b) => (
                      <li key={b.token}><code>{b.token}</code> - {b.desc}</li>
                    ))}
                  </ul>
                </>
              )}

              {settingsTab === "shortcuts" && (
                <>
                  <div className="map-sidebar__shortcut"><kbd>⌘/Ctrl + K</kbd><span>{t("mapSidebar.shortcut.searchSystems")}</span></div>
                  <div className="map-sidebar__shortcut"><kbd>H</kbd><span>{t("mapSidebar.shortcut.centreHome")}</span></div>
                  <div className="map-sidebar__shortcut"><kbd>Del</kbd><span>{t("mapSidebar.shortcut.removeSelected")}</span></div>
                  <div className="map-sidebar__shortcut"><kbd>⌘/Ctrl + Z</kbd><span>{t("mapSidebar.shortcut.undo")}</span></div>
                  <div className="map-sidebar__shortcut"><kbd>Shift + click</kbd><span>{t("mapSidebar.shortcut.multiSelect")}</span></div>
                  <div className="map-sidebar__shortcut"><kbd>Shift + drag</kbd><span>{t("mapSidebar.shortcut.rubberBand")}</span></div>
                  <div className="map-sidebar__shortcut"><kbd>Shift + ⌘/Ctrl + V</kbd><span>{t("mapSidebar.shortcut.overwriteSigs")}</span></div>
                  <p className="map-sidebar__shortcut-note">{t("mapSidebar.shortcut.vivaldiNote")}</p>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
