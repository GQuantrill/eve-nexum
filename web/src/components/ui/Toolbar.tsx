import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { timeAgo, jumps } from '../../i18n/format';
import { useMapStore } from '../../store/mapStore';
import { useAuth } from '../../context/AuthContext';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useCharacterLocation } from '../../hooks/useCharacterLocation';
import { useCanEdit } from '../../hooks/useCanEdit';
import { useIsMapOwner } from '../../hooks/useIsMapOwner';
import { useCanCreateMaps } from '../../hooks/useCanCreateMaps';
import { UserStatsModal } from './UserStatsModal';
import { ConfirmModal } from './ConfirmModal';
import { CreateMapModal } from './CreateMapModal';
import { ApiKeysModal } from './ApiKeysModal';
import { LanguageSwitcher } from './LanguageSwitcher';
import { CharacterSwitcher } from './CharacterSwitcher';
import { HeatmapMenu } from './HeatmapMenu';
import { WhTypeChartModal } from './WhTypeChartModal';
import { useProximityAlerts } from '../../hooks/useProximityAlerts';
import {
  WarningIcon, SkullIcon, XCircleIcon, QuestionIcon,
  ShieldStarIcon, ChartBarIcon, SlidersHorizontalIcon, FootprintsIcon,
  SignOutIcon, PlanetIcon, LinkSimpleIcon, ClockCountdownIcon, MapPinIcon,
  KeyIcon, GraphIcon,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';
import { charPortrait, typeIcon } from '../../utils/eveImages';

interface EveStatus {
  players:    number;
  serverUp:   boolean; // 200 from status endpoint
  esiOnline:  boolean; // fetch reached ESI at all
}

// Cross-tab cache: when one tab polls ESI, the result is written to localStorage
// and all other tabs receive it via the `storage` event. Each tab still ticks
// every minute, but skips the network call if another tab has already populated
// a fresh value — so steady-state polling is one ESI call per minute total,
// not one per tab.
const STATUS_KEY = 'nexum.eveStatus';
const POLL_MS    = 60_000;

interface CachedStatus { value: EveStatus; at: number }

function readCache(): CachedStatus | null {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedStatus;
    if (!parsed.value || typeof parsed.at !== 'number') return null;
    return parsed;
  } catch { return null; }
}

function writeCache(value: EveStatus) {
  try {
    localStorage.setItem(STATUS_KEY, JSON.stringify({ value, at: Date.now() } as CachedStatus));
  } catch { /* quota / private mode — ignore */ }
}

function useEveServerStatus(): EveStatus | null {
  const [status, setStatus] = useState<EveStatus | null>(() => readCache()?.value ?? null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const cached = readCache();
      if (cached && Date.now() - cached.at < POLL_MS) {
        if (!cancelled) setStatus(cached.value);
        return;
      }
      let esiOnline = false;
      let serverUp  = false;
      let players   = 0;
      try {
        const res = await fetch('https://esi.evetech.net/latest/status/?datasource=tranquility', {
          signal: AbortSignal.timeout(10_000),
        });
        esiOnline = true;
        if (res.ok) {
          const data = await res.json() as { players?: number };
          serverUp = true;
          players  = data.players ?? 0;
        }
      } catch {
        // esiOnline stays false
      }
      const value: EveStatus = { players, serverUp, esiOnline };
      writeCache(value);
      if (!cancelled) setStatus(value);
    }

    tick();
    const id = setInterval(tick, POLL_MS);

    // Other tabs writing to STATUS_KEY → fire `storage` event here
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STATUS_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue) as CachedStatus;
        if (!cancelled && parsed.value) setStatus(parsed.value);
      } catch { /* ignore malformed payloads */ }
    };
    window.addEventListener('storage', onStorage);

    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  return status;
}

// Build the tooltip for the online-status dot. When ESI reports online we
// surface the TQ session-start timestamp + how long ago it was, so an
// orphan session ("online for 6 hours but I crashed at lunchtime") is
// instantly recognisable from the tooltip alone.
function onlineTooltip(t: TFunction, online: boolean | null, lastLoginIso: string | null): string {
  if (online === false) return t('toolbar.online.offline');
  if (online === null)  return t('toolbar.online.statusUnknown');
  if (!lastLoginIso)    return t('toolbar.online.onlineInEve');
  const ts = new Date(lastLoginIso);
  if (!Number.isFinite(ts.getTime())) return t('toolbar.online.onlineInEve');
  // DD-MM-YYYY HH:MM UTC matches the rest of the app's date display.
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${pad(ts.getUTCDate())}-${pad(ts.getUTCMonth() + 1)}-${ts.getUTCFullYear()} ${pad(ts.getUTCHours())}:${pad(ts.getUTCMinutes())} UTC`;
  return t('toolbar.online.onlineSince', { stamp, age: timeAgo(t, ts) });
}

// Compact "last checked" indicator: a clock icon whose tooltip carries the
// "checked Xs ago" text. Owns its own 5 s tick so the rest of the Toolbar
// doesn't re-render every five seconds along with it.
function CheckedAtIcon({ checkedAt }: { checkedAt: Date }) {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span
      className="toolbar__checked-icon"
      data-tooltip={t('toolbar.checkedAgo', { time: timeAgo(t, checkedAt) })}
      aria-label={t('toolbar.checkedAgo', { time: timeAgo(t, checkedAt) })}
    >
      <ClockCountdownIcon size={12} weight="regular" />
    </span>
  );
}

// Persistent indicator for the nearest live threat (incursion / insurgency).
// Mounts the proximity hook (which also fires the browser notification + beep
// on threshold crossings — Toolbar is rendered once for every logged-in user).
function ProximityChip() {
  const { nearest, threshold } = useProximityAlerts();
  const { t } = useTranslation();
  // The user's configurable threshold gates both display and the alert state —
  // if the chip is shown, the threat is in-zone by definition. Filters out the
  // permanent "20 jumps — …" noise on most maps.
  if (!nearest || nearest.jumps > threshold) return null;
  const { label, Icon }: { label: string; Icon: PhosphorIcon } =
    nearest.kind === 'incursion'   ? { label: t('toolbar.proximity.incursion'),  Icon: WarningIcon } :
    nearest.kind === 'insurgency'  ? { label: t('toolbar.proximity.insurgency'), Icon: SkullIcon } :
    nearest.kind === 'hostile-sov' ? { label: t('toolbar.proximity.hostileSov'), Icon: XCircleIcon } :
    { label: t('toolbar.proximity.threat'), Icon: QuestionIcon };
  return (
    <span
      className="toolbar__proximity toolbar__proximity--alert tooltip-right"
      data-tooltip={t('toolbar.proximity.closest', { label: label.toLowerCase() })}
    >
      <span className="toolbar__proximity-icon"><Icon size={14} weight="bold" /></span>
      <span className="toolbar__proximity-text">
        {nearest.jumps === 0 ? 'IN' : jumps(t, nearest.jumps)} - {label}
      </span>
    </span>
  );
}

export function Toolbar() {
  const { t } = useTranslation();
  const mapName         = useMapStore((s) => s.map.name);
  const mapLocked       = useMapStore((s) => !!s.map.locked);
  const systemCount     = useMapStore((s) => s.map.systems.length);
  const mapSystems      = useMapStore((s) => s.map.systems);
  const requestCenterOnEveSystem = useMapStore((s) => s.requestCenterOnEveSystem);
  const connectionCount = useMapStore((s) => s.map.connections.length);
  const maps            = useMapStore((s) => s.maps);
  const maxMaps         = useMapStore((s) => s.maxMaps);
  const maxCorpMaps     = useMapStore((s) => s.maxCorpMaps);
  const corpMapCount    = useMapStore((s) => s.corpMapCount);
  const activeMapId     = useMapStore((s) => s.activeMapId);
  const setMapName      = useMapStore((s) => s.setMapName);
  const switchMap       = useMapStore((s) => s.switchMap);
  const requestFitView  = useMapStore((s) => s.requestFitView);
  const deleteMap       = useMapStore((s) => s.deleteMap);
  const mapOptionsOpen  = useMapStore((s) => s.mapOptionsOpen);
  const setMapOptionsOpen = useMapStore((s) => s.setMapOptionsOpen);
  const trackJumps      = useMapStore((s) => s.trackJumps);
  const setTrackJumps   = useMapStore((s) => s.setTrackJumps);

  const atMapLimit      = maps.filter((m) => !m.isCorpMap).length >= maxMaps;
  const atCorpMapLimit  = corpMapCount >= maxCorpMaps;
  const { user, logout } = useAuth();
  const canEdit       = useCanEdit();
  const isMapOwner    = useIsMapOwner();
  const canManageMaps = useCanCreateMaps();
  const canCorpCreate = !!user?.corpMode && canManageMaps;
  // No creatable option = personal slots full AND (can't make corp maps, or
  // corp slots full too). Gates the single "+ New Map" action.
  const noCreateOption = atMapLimit && (!canCorpCreate || atCorpMapLimit);
  const { online, checkedAt, lastLogin } = useOnlineStatus(!!user);
  // Ship + live system come from the same poll that drives passive location
  // tracking, so no extra ESI traffic — we just surface fields already on hand.
  const { ship, system: liveSystem, online: locOnline } = useCharacterLocation();
  // What to show next to the avatar: the live system when the pilot is online
  // in EVE, otherwise the last known system from their profile.
  const shownSystem = (locOnline && liveSystem?.name) ? liveSystem.name : (user?.lastKnownSystem?.name ?? null);
  const shownSystemIsLast = !(locOnline && liveSystem?.name);
  const shownSystemEveId = (locOnline && liveSystem?.eveSystemId) ? liveSystem.eveSystemId : (user?.lastKnownSystem?.id ?? null);
  // Clicking the system centres the map on it — but only when it's actually on
  // the current map.
  const shownSystemOnMap = shownSystemEveId != null && mapSystems.some((s) => s.eveSystemId === shownSystemEveId);
  const eveStatus = useEveServerStatus();
  const [showMaps, setShowMaps]   = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [showWhChart, setShowWhChart] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  async function handleDeleteMap() {
    if (!activeMapId) return;
    await deleteMap(activeMapId);
  }

  return (
    <>
    <header className="toolbar">
      <div className="toolbar__brand">
        <span className="toolbar__logo">◈</span>
      </div>

      {/* Map switcher */}
      <div className="toolbar__map-switcher">
        <button
          className="toolbar__map-name-btn"
          onClick={() => setShowMaps((v) => !v)}
          title={t('toolbar.switchMap')}
        >
          {(() => {
            const active = maps.find((m) => m.id === activeMapId);
            if (!active) return null;
            if (active.sharedWithMe) {
              return <span className="toolbar__map-type toolbar__map-type--shared">{t('toolbar.mapType.shared')}</span>;
            }
            if (!user?.corpMode) return null;
            return active.isCorpMap
              ? <span className="toolbar__map-type toolbar__map-type--corp">{t('toolbar.mapType.corp')}</span>
              : <span className="toolbar__map-type toolbar__map-type--solo">{t('toolbar.mapType.solo')}</span>;
          })()}
          {mapName || t('toolbar.noMap')}
          <span className="toolbar__caret">▾</span>
        </button>

        {mapLocked && (
          <span
            className="toolbar__locked-chip"
            data-tooltip={t('toolbar.lockedTooltip')}
          >
            <span className="toolbar__locked-icon">🔒</span>
            {t('toolbar.locked')}
          </span>
        )}

        {showMaps && (
          <div className="map-dropdown" onMouseLeave={() => setShowMaps(false)}>
            {[...maps].sort((a, b) => {
              // Three-tier ordering: own personal → corp → shared-with-me.
              // Inside a tier, alphabetical by name.
              const aTier = a.sharedWithMe ? 2 : a.isCorpMap ? 1 : 0;
              const bTier = b.sharedWithMe ? 2 : b.isCorpMap ? 1 : 0;
              if (aTier !== bTier) return aTier - bTier;
              return a.name.localeCompare(b.name);
            }).map((m) => (
              <button
                key={m.id}
                className={`map-dropdown__item${m.id === activeMapId ? ' map-dropdown__item--active' : ''}`}
                onClick={async () => { setShowMaps(false); await switchMap(m.id); requestFitView(); }}
              >
                {m.sharedWithMe
                  ? <span className="map-dropdown__badge map-dropdown__badge--shared">{t('toolbar.mapType.shared')}</span>
                  : user?.corpMode && !m.isCorpMap
                    ? <span className="map-dropdown__badge map-dropdown__badge--solo">{t('toolbar.mapType.solo')}</span>
                    : null}
                {!m.sharedWithMe && m.isCorpMap && <span className="map-dropdown__badge map-dropdown__badge--corp">{t('toolbar.mapType.corp')}</span>}
                {m.locked    && <span className="map-dropdown__badge map-dropdown__badge--lock">🔒</span>}
                {m.name}
              </button>
            ))}
            <div className="map-dropdown__divider" />
            <span
              className={`map-dropdown__new-wrap${noCreateOption ? ' map-dropdown__new-wrap--disabled' : ''}`}
              data-disabled-reason={noCreateOption ? t('toolbar.mapLimitReached') : undefined}
            >
              <button
                className="map-dropdown__item map-dropdown__item--action"
                onClick={() => { setShowMaps(false); setShowCreate(true); }}
                disabled={noCreateOption}
              >
                {t('toolbar.newMap')}
              </button>
            </span>
            {canManageMaps && maps.length > 1 && !maps.find((m) => m.id === activeMapId)?.sharedWithMe && (
              <button className="map-dropdown__item map-dropdown__item--danger" onClick={() => { setShowMaps(false); setDeleteConfirm(true); }}>
                {t('toolbar.deleteThisMap')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Map name edit */}
      <div className="toolbar__option">
        <label className="toolbar__option-label" htmlFor="map-name">{t('toolbar.name')}</label>
        <input
          id="map-name"
          className="toolbar__map-name"
          value={mapName}
          onChange={(e) => setMapName(e.target.value)}
          spellCheck={false}
          readOnly={!canEdit || !isMapOwner}
        />
      </div>

      <div className="toolbar__spacer" />

      <div className="toolbar__stats">
        <span className="toolbar__stat" data-tooltip={t('toolbar.totalSystems')}>
          <PlanetIcon size={16} weight="regular" />
          <span className="toolbar__stat-count">{systemCount}</span>
        </span>
        <span className="toolbar__stat" data-tooltip={t('toolbar.totalConnections')}>
          <LinkSimpleIcon size={16} weight="regular" />
          <span className="toolbar__stat-count">{connectionCount}</span>
        </span>
      </div>

      <ProximityChip />

      <div className="toolbar__spacer" />

      {user && (user.canViewReports || (user.role === 'admin' && user.corpMode)) && (
        <button
          className="toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent"
          onClick={() => { window.location.hash = '#/admin/users'; }}
          data-tooltip={t('toolbar.admin')}
          aria-label={t('toolbar.admin')}
        >
          <ShieldStarIcon size={18} weight="regular" />
        </button>
      )}
      <button
        className="toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent"
        onClick={() => setShowStats(true)}
        data-tooltip={t('toolbar.userStats')}
        aria-label={t('toolbar.userStats')}
      >
        <ChartBarIcon size={18} weight="regular" />
      </button>

      <a
        className="toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent"
        href="/help/"
        target="_blank"
        rel="noopener noreferrer"
        data-tooltip={t('toolbar.help')}
        aria-label={t('toolbar.help')}
      >
        <QuestionIcon size={18} weight="regular" />
      </a>

      <button
        className="toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent"
        onClick={() => setShowWhChart(true)}
        data-tooltip={t('whChart.tooltip')}
        aria-label={t('whChart.title')}
      >
        <GraphIcon size={18} weight="regular" />
      </button>

      <HeatmapMenu />

      <button
        className={`toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent${mapOptionsOpen ? ' toolbar__toggle--on' : ''}`}
        onClick={() => setMapOptionsOpen(!mapOptionsOpen)}
        aria-pressed={mapOptionsOpen}
        data-tooltip={t('toolbar.mapOptions')}
        aria-label={t('toolbar.mapOptions')}
      >
        <SlidersHorizontalIcon size={18} weight="regular" />
      </button>

      <div className="toolbar__server-status">
        <div className="toolbar__server-row">
          <span
            className={`toolbar__status-dot${
              eveStatus == null ? '' :
              eveStatus.serverUp ? ' toolbar__status-dot--on' : ' toolbar__status-dot--off'
            }`}
            data-tooltip={
              eveStatus == null ? t('toolbar.checking') :
              eveStatus.serverUp ? t('toolbar.tqOnline') : t('toolbar.tqOffline')
            }
          />
          <span className="toolbar__server-label">TQ</span>
          {eveStatus?.serverUp && (
            <span className="toolbar__player-count">
              {eveStatus.players.toLocaleString()}
            </span>
          )}
        </div>
        <div className="toolbar__server-row">
          <span
            className={`toolbar__status-dot${
              eveStatus == null ? '' :
              eveStatus.esiOnline ? ' toolbar__status-dot--on' : ' toolbar__status-dot--off'
            }`}
            data-tooltip={
              eveStatus == null ? t('toolbar.checking') :
              eveStatus.esiOnline ? t('toolbar.esiOnline') : t('toolbar.esiOffline')
            }
          />
          <span className="toolbar__server-label">ESI</span>
        </div>
      </div>

      <button
        className={`toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent${trackJumps ? ' toolbar__toggle--on' : ''}`}
        onClick={() => setTrackJumps(!trackJumps)}
        aria-pressed={trackJumps}
        aria-label={trackJumps ? t('toolbar.trackJumpsOn') : t('toolbar.trackJumpsOff')}
        data-tooltip={trackJumps
          ? t('toolbar.trackJumpsTooltipOn')
          : t('toolbar.trackJumpsTooltipOff')}
      >
        <FootprintsIcon size={18} weight="regular" />
        <span className={`toolbar__toggle-led${trackJumps ? ' toolbar__toggle-led--on' : ' toolbar__toggle-led--off'}`} />
      </button>

      {user && (
        <div className="toolbar__user">
          <span
            className={`toolbar__online-dot${online === true ? ' toolbar__online-dot--on' : online === false ? ' toolbar__online-dot--off' : ''}`}
            title={onlineTooltip(t, online, lastLogin)}
          />
          <img
            className="toolbar__avatar"
            src={charPortrait(user.characterId, 64)}
            alt={user.characterName}
          />
          {ship && (
            <span
              className="toolbar__ship-wrap"
              data-tooltip={ship.shipName && ship.shipName !== ship.typeName
                ? `${ship.typeName} — ${ship.shipName}`
                : ship.typeName}
            >
              <img
                className="toolbar__ship"
                src={typeIcon(ship.typeId, 64)}
                alt={ship.typeName}
              />
            </span>
          )}
          <div className="toolbar__char-info">
            <span className="toolbar__char-name">
              {user.characterName}
              {/* Role only matters in corp mode — in solo deployments every
                  user is implicitly admin of their own maps, so the badge
                  just adds noise. */}
              {user.corpMode && (
                <span
                  className={`role-badge role-badge--${user.role}`}
                  title={t('toolbar.role', { role: user.role })}
                >
                  {user.role}
                </span>
              )}
            </span>
            <div className="toolbar__char-sub">
              {shownSystem && (shownSystemOnMap ? (
                <button
                  type="button"
                  className="toolbar__char-system toolbar__char-system--clickable"
                  data-tooltip={t('toolbar.centerOnSystem', { system: shownSystem })}
                  onClick={() => { if (shownSystemEveId != null) requestCenterOnEveSystem(shownSystemEveId); }}
                >
                  <MapPinIcon size={11} weight="fill" />
                  {shownSystem}
                </button>
              ) : (
                <span
                  className="toolbar__char-system"
                  data-tooltip={shownSystemIsLast ? t('toolbar.lastKnownSystem') : t('toolbar.currentSystem')}
                >
                  <MapPinIcon size={11} weight="fill" />
                  {shownSystem}
                </span>
              ))}
              {checkedAt && <CheckedAtIcon checkedAt={checkedAt} />}
            </div>
          </div>
          <CharacterSwitcher />
          <LanguageSwitcher />
          <button
            className="toolbar__toggle toolbar__toggle--icon"
            onClick={() => setShowKeys(true)}
            data-tooltip={t('apiKeys.title')}
            aria-label={t('apiKeys.title')}
          >
            <KeyIcon size={18} weight="regular" />
          </button>
          <button
            className="toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent"
            onClick={logout}
            data-tooltip={t('toolbar.signOut')}
            aria-label={t('toolbar.signOut')}
          >
            <SignOutIcon size={18} weight="regular" />
          </button>
        </div>
      )}
    </header>

    {showStats && <UserStatsModal onClose={() => setShowStats(false)} />}
    {showCreate && <CreateMapModal onClose={() => setShowCreate(false)} />}
    {showKeys && <ApiKeysModal onClose={() => setShowKeys(false)} />}
    {showWhChart && <WhTypeChartModal onClose={() => setShowWhChart(false)} />}
    {deleteConfirm && (
      <ConfirmModal
        message={t('toolbar.deleteMapConfirm', { name: mapName })}
        onCancel={() => setDeleteConfirm(false)}
        onConfirm={async () => {
          setDeleteConfirm(false);
          await handleDeleteMap();
        }}
      />
    )}
    </>
  );
}
