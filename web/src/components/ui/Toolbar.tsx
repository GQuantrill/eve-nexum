import { useState, useEffect } from 'react';
import { useMapStore } from '../../store/mapStore';
import { useAuth } from '../../context/AuthContext';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useCanEdit } from '../../hooks/useCanEdit';
import { useCanCreateMaps } from '../../hooks/useCanCreateMaps';
import { UserStatsModal } from './UserStatsModal';
import { ConfirmModal } from './ConfirmModal';
import { PromptModal } from './PromptModal';
import { useProximityAlerts } from '../../hooks/useProximityAlerts';

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

function formatCheckedAt(date: Date): string {
  const secs = Math.floor((Date.now() - date.getTime()) / 1000);
  if (secs < 5)  return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.floor(secs / 60)}m ago`;
}

// Self-contained "checked Xs ago" label — owns its own 5 s tick so the rest of
// the Toolbar doesn't re-render every five seconds along with it.
function CheckedAtLabel({ checkedAt }: { checkedAt: Date }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);
  return <span className="toolbar__checked-at">checked {formatCheckedAt(checkedAt)}</span>;
}

// Persistent indicator for the nearest live threat (incursion / insurgency).
// Mounts the proximity hook (which also fires the browser notification + beep
// on threshold crossings — Toolbar is rendered once for every logged-in user).
function ProximityChip() {
  const { nearest, threshold } = useProximityAlerts();
  if (!nearest) return null;
  const inZone = nearest.jumps <= threshold;
  const { label, icon } =
    nearest.kind === 'incursion'   ? { label: 'Incursion',   icon: '⚠' } :
    nearest.kind === 'insurgency'  ? { label: 'Insurgency',  icon: '☠' } :
    nearest.kind === 'hostile-sov' ? { label: 'Hostile sov', icon: '✖' } :
    { label: 'Threat', icon: '?' };
  return (
    <span
      className={`toolbar__proximity${inZone ? ' toolbar__proximity--alert' : ''}`}
      data-tooltip={`Closest ${label.toLowerCase()} system`}
    >
      <span className="toolbar__proximity-icon">{icon}</span>
      <span className="toolbar__proximity-text">
        {nearest.jumps === 0 ? 'IN' : `${nearest.jumps} jumps`} - {label}
      </span>
    </span>
  );
}

export function Toolbar() {
  const mapName         = useMapStore((s) => s.map.name);
  const mapLocked       = useMapStore((s) => !!s.map.locked);
  const systemCount     = useMapStore((s) => s.map.systems.length);
  const connectionCount = useMapStore((s) => s.map.connections.length);
  const maps            = useMapStore((s) => s.maps);
  const maxMaps         = useMapStore((s) => s.maxMaps);
  const maxCorpMaps     = useMapStore((s) => s.maxCorpMaps);
  const corpMapCount    = useMapStore((s) => s.corpMapCount);
  const activeMapId     = useMapStore((s) => s.activeMapId);
  const setMapName      = useMapStore((s) => s.setMapName);
  const switchMap       = useMapStore((s) => s.switchMap);
  const createMap       = useMapStore((s) => s.createMap);
  const deleteMap       = useMapStore((s) => s.deleteMap);
  const mapOptionsOpen  = useMapStore((s) => s.mapOptionsOpen);
  const setMapOptionsOpen = useMapStore((s) => s.setMapOptionsOpen);

  const atMapLimit      = maps.filter((m) => !m.isCorpMap).length >= maxMaps;
  const atCorpMapLimit  = corpMapCount >= maxCorpMaps;
  const { user, logout } = useAuth();
  const canEdit       = useCanEdit();
  const canManageMaps = useCanCreateMaps();
  const { online, checkedAt } = useOnlineStatus(!!user);
  const eveStatus = useEveServerStatus();
  const [showMaps, setShowMaps]   = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [newMapPrompt, setNewMapPrompt] = useState<{ isCorpMap: boolean } | null>(null);
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
          title="Switch map"
        >
          {user?.corpMode && (() => {
            const active = maps.find((m) => m.id === activeMapId);
            if (!active) return null;
            return active.isCorpMap
              ? <span className="toolbar__map-type toolbar__map-type--corp">Corp</span>
              : <span className="toolbar__map-type toolbar__map-type--solo">Solo</span>;
          })()}
          {mapName || 'No Map'}
          <span className="toolbar__caret">▾</span>
        </button>

        {mapLocked && (
          <span
            className="toolbar__locked-chip"
            data-tooltip="Map is locked — systems and connections are frozen. Signatures, structures, and notes can still be edited."
          >
            <span className="toolbar__locked-icon">🔒</span>
            Locked
          </span>
        )}

        {showMaps && (
          <div className="map-dropdown" onMouseLeave={() => setShowMaps(false)}>
            {[...maps].sort((a, b) => {
              if (a.isCorpMap !== b.isCorpMap) return a.isCorpMap ? 1 : -1;
              return a.name.localeCompare(b.name);
            }).map((m) => (
              <button
                key={m.id}
                className={`map-dropdown__item${m.id === activeMapId ? ' map-dropdown__item--active' : ''}`}
                onClick={() => { switchMap(m.id); setShowMaps(false); }}
              >
                {user?.corpMode && !m.isCorpMap && <span className="map-dropdown__badge map-dropdown__badge--solo">Solo</span>}
                {m.isCorpMap && <span className="map-dropdown__badge map-dropdown__badge--corp">Corp</span>}
                {m.locked    && <span className="map-dropdown__badge map-dropdown__badge--lock">🔒</span>}
                {m.name}
              </button>
            ))}
            <div className="map-dropdown__divider" />
            <span
              className={`map-dropdown__new-wrap${atMapLimit ? ' map-dropdown__new-wrap--disabled' : ''}`}
              data-disabled-reason={atMapLimit ? `Personal map limit reached (${maxMaps})` : undefined}
            >
              <button
                className="map-dropdown__item map-dropdown__item--action"
                onClick={() => { setShowMaps(false); setNewMapPrompt({ isCorpMap: false }); }}
                disabled={atMapLimit}
              >
                + Personal Map
              </button>
              {user?.corpMode && canManageMaps && (
                <span
                  className={`map-dropdown__new-wrap${atCorpMapLimit ? ' map-dropdown__new-wrap--disabled' : ''}`}
                  data-disabled-reason={atCorpMapLimit ? `Corp map limit reached (${maxCorpMaps})` : undefined}
                >
                  <button
                    className="map-dropdown__item map-dropdown__item--action"
                    onClick={() => { setShowMaps(false); setNewMapPrompt({ isCorpMap: true }); }}
                    disabled={atCorpMapLimit}
                  >
                    + Corp Map
                  </button>
                </span>
              )}
            </span>
            {canManageMaps && maps.length > 1 && (
              <button className="map-dropdown__item map-dropdown__item--danger" onClick={() => { setShowMaps(false); setDeleteConfirm(true); }}>
                Delete this map
              </button>
            )}
          </div>
        )}
      </div>

      {/* Map name edit */}
      <div className="toolbar__option">
        <label className="toolbar__option-label" htmlFor="map-name">Name</label>
        <input
          id="map-name"
          className="toolbar__map-name"
          value={mapName}
          onChange={(e) => setMapName(e.target.value)}
          spellCheck={false}
          readOnly={!canEdit}
        />
      </div>

      <div className="toolbar__spacer" />

      <div className="toolbar__stats">
        <span>{systemCount} systems</span>
        <span>{connectionCount} connections</span>
      </div>

      <ProximityChip />

      <div className="toolbar__spacer" />

      {user && (user.canViewReports || (user.role === 'admin' && user.corpMode)) && (
        <button
          className="toolbar__toggle"
          onClick={() => { window.location.hash = '#/admin/users'; }}
        >
          Admin
        </button>
      )}
      <button
        className="toolbar__toggle"
        onClick={() => setShowStats(true)}
      >
        User Stats
      </button>



      <button
        className={`toolbar__toggle${mapOptionsOpen ? ' toolbar__toggle--on' : ''}`}
        onClick={() => setMapOptionsOpen(!mapOptionsOpen)}
        aria-pressed={mapOptionsOpen}
      >
        Map Options
      </button>

      <div className="toolbar__server-status">
        <div className="toolbar__server-row">
          <span
            className={`toolbar__status-dot${
              eveStatus == null ? '' :
              eveStatus.serverUp ? ' toolbar__status-dot--on' : ' toolbar__status-dot--off'
            }`}
            data-tooltip={
              eveStatus == null ? 'Checking…' :
              eveStatus.serverUp ? 'Tranquility: Online' : 'Tranquility: Offline'
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
              eveStatus == null ? 'Checking…' :
              eveStatus.esiOnline ? 'ESI: Online' : 'ESI: Offline'
            }
          />
          <span className="toolbar__server-label">ESI</span>
        </div>
      </div>

      {user && (
        <div className="toolbar__user">
          <span
            className={`toolbar__online-dot${online === true ? ' toolbar__online-dot--on' : online === false ? ' toolbar__online-dot--off' : ''}`}
            title={online === true ? 'Online in EVE' : online === false ? 'Offline' : 'Status unknown'}
          />
          <img
            className="toolbar__avatar"
            src={`https://images.evetech.net/characters/${user.characterId}/portrait?size=64`}
            alt={user.characterName}
          />
          <div className="toolbar__char-info">
            <span className="toolbar__char-name">
              {user.characterName}
              {/* Role only matters in corp mode — in solo deployments every
                  user is implicitly admin of their own maps, so the badge
                  just adds noise. */}
              {user.corpMode && (
                <span
                  className={`role-badge role-badge--${user.role}`}
                  title={`Role: ${user.role}`}
                >
                  {user.role}
                </span>
              )}
            </span>
            {checkedAt && <CheckedAtLabel checkedAt={checkedAt} />}
          </div>
          <button className="btn btn--ghost btn--sm" onClick={logout}>Logout</button>
        </div>
      )}
    </header>

    {showStats && <UserStatsModal onClose={() => setShowStats(false)} />}
    {newMapPrompt && (
      <PromptModal
        title={newMapPrompt.isCorpMap ? 'New Corp Map' : 'New Map'}
        message="Enter a name for the new map."
        defaultValue="New Map"
        confirmLabel="Create"
        onCancel={() => setNewMapPrompt(null)}
        onConfirm={async (name) => {
          const { isCorpMap } = newMapPrompt;
          setNewMapPrompt(null);
          await createMap(name, isCorpMap);
        }}
      />
    )}
    {deleteConfirm && (
      <ConfirmModal
        message={`Delete "${mapName}"? This cannot be undone.`}
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
