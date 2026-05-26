import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useHashRoute } from '../../hooks/useHashRoute';
import { ConfirmModal } from './ConfirmModal';
import {
  Chart as ChartJS,
  ArcElement, CategoryScale, LinearScale,
  PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { Doughnut, Line } from 'react-chartjs-2';
import { CaretUpIcon, CaretDownIcon } from '@phosphor-icons/react';

// Register only the chart pieces we actually use — keeps the bundle lean.
ChartJS.register(ArcElement, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

type Role = 'admin' | 'full' | 'edit' | 'readonly';
const ROLES: Role[] = ['admin', 'full', 'edit', 'readonly'];

type Tab = 'users' | 'maps' | 'reports' | 'audit';

const ALL_TABS: { key: Tab; label: string; path: string }[] = [
  { key: 'users',   label: 'Users',     path: '/admin/users'   },
  { key: 'maps',    label: 'Maps',      path: '/admin/maps'    },
  { key: 'reports', label: 'Reports',   path: '/admin/reports' },
  { key: 'audit',   label: 'Audit log', path: '/admin/audit'   },
];

export function AdminPage() {
  const [path, navigate] = useHashRoute();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canSeeReports = !!user?.canViewReports;
  const tabs = useMemo(
    () => ALL_TABS.filter((t) => {
      if (t.key === 'reports') return isAdmin || canSeeReports;
      if (t.key === 'users')   return isAdmin || canSeeReports;
      return isAdmin;
    }),
    [isAdmin, canSeeReports],
  );
  const tab = pathToTab(path, isAdmin, canSeeReports);

  return (
    <div className="admin-page">
      <aside className="admin-page__nav">
        <button className="admin-page__back" onClick={() => navigate('/')}>← Back to maps</button>
        <h1 className="admin-page__title">Admin</h1>
        <nav className="admin-page__tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              className={`admin-page__tab${tab === t.key ? ' admin-page__tab--active' : ''}`}
              onClick={() => navigate(t.path)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </aside>

      <main className="admin-page__content">
        {tab === 'users'   && (isAdmin || canSeeReports) && <UsersTab />}
        {tab === 'maps'    && isAdmin       && <MapsTab />}
        {tab === 'reports' && (isAdmin || canSeeReports) && <ReportsTab />}
        {tab === 'audit'   && isAdmin       && <AuditTab />}
      </main>
    </div>
  );
}

function pathToTab(path: string, isAdmin: boolean, canSeeReports: boolean): Tab {
  const fallback: Tab = isAdmin || canSeeReports ? 'users' : 'reports';
  if (path.startsWith('/admin/maps'))    return isAdmin       ? 'maps'    : fallback;
  if (path.startsWith('/admin/reports')) return (isAdmin || canSeeReports) ? 'reports' : fallback;
  if (path.startsWith('/admin/audit'))   return isAdmin       ? 'audit'   : fallback;
  return fallback;
}

// ── Users tab ───────────────────────────────────────────────────────────────

interface AdminUser {
  id:              number;
  characterId:     number;
  characterName:   string;
  role:            Role;
  corpId:          number | null;
  corpTicker:      string | null;
  corpName:        string | null;
  allianceId:      number | null;
  allianceTicker:  string | null;
  allianceName:    string | null;
  blocked:         boolean;
  createdAt:       string;
  lastLogin:       string;
  totalEvents:     number;
  totalSignatures: number;
}

type UserSortKey = 'characterName' | 'corpTicker' | 'allianceTicker' | 'role' | 'blocked' | 'lastLogin';
interface UserSort { key: UserSortKey; dir: 'asc' | 'desc' }

// Click-to-sort header cell. Shows an arrow on the currently-sorted column,
// faded indicator on the others to hint at the affordance.
function SortableTh({ col, label, sort, onToggle }: {
  col:      UserSortKey;
  label:    string;
  sort:     UserSort;
  onToggle: (k: UserSortKey) => void;
}) {
  const active = sort.key === col;
  const arrow  = active ? (sort.dir === 'asc' ? '↑' : '↓') : '↕';
  return (
    <th
      className={`admin-modal__th-sort${active ? ' admin-modal__th-sort--active' : ''}`}
      onClick={() => onToggle(col)}
      role="button"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label} <span className="admin-modal__th-sort-arrow">{arrow}</span>
    </th>
  );
}

// Compare helper — keeps nulls at the bottom on asc, top on desc so the
// "no alliance" rows don't get scattered through the middle of the list.
function compareUsers(a: AdminUser, b: AdminUser, sort: UserSort): number {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const av  = a[sort.key];
  const bv  = b[sort.key];
  if (av === null && bv === null) return 0;
  if (av === null) return 1;   // nulls always last regardless of dir
  if (bv === null) return -1;
  if (typeof av === 'string' && typeof bv === 'string') {
    return av.localeCompare(bv, undefined, { sensitivity: 'base' }) * dir;
  }
  if (typeof av === 'boolean' && typeof bv === 'boolean') {
    return (Number(av) - Number(bv)) * dir;
  }
  // Last login arrives as ISO string but should sort lexicographically anyway.
  return String(av).localeCompare(String(bv)) * dir;
}

function UsersTab() {
  const { user: self } = useAuth();
  const canEdit = self?.role === 'admin';
  const [users, setUsers]     = useState<AdminUser[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [busyId, setBusyId]   = useState<number | null>(null);
  const [blockTarget, setBlockTarget] = useState<AdminUser | null>(null);
  // Default: alphabetical by character name.
  const [sort, setSort] = useState<UserSort>({ key: 'characterName', dir: 'asc' });

  function toggleSort(key: UserSortKey) {
    setSort((prev) => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  }

  const sortedUsers = useMemo(
    () => (users ? [...users].sort((a, b) => compareUsers(a, b, sort)) : null),
    [users, sort],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ users: AdminUser[] }>('/api/admin/users');
      setUsers(r.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load users');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function changeRole(u: AdminUser, role: Role) {
    if (u.role === role) return;
    setBusyId(u.id);
    try {
      await api(`/api/admin/users/${u.id}/role`, {
        method: 'PATCH',
        body:   JSON.stringify({ role }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Role change failed');
    } finally {
      setBusyId(null);
    }
  }

  async function setBlocked(u: AdminUser, blocked: boolean) {
    setBusyId(u.id);
    try {
      await api(`/api/admin/users/${u.id}/${blocked ? 'block' : 'unblock'}`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Block change failed');
    } finally {
      setBusyId(null);
      setBlockTarget(null);
    }
  }

  async function recheckCorp(u: AdminUser) {
    setBusyId(u.id);
    try {
      await api(`/api/admin/users/${u.id}/recheck-corp`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recheck failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <h2 className="admin-page__section-title">Users</h2>
      {error && <div className="admin-page__error">{error}</div>}
      {!users && !error && <div className="admin-page__loading">Loading…</div>}
      {users && !users.length && <div className="admin-page__empty">No users yet.</div>}
      {users && users.length > 0 && (
        <table className="admin-modal__table">
          <thead>
            <tr>
              <SortableTh col="characterName"  label="Character"  sort={sort} onToggle={toggleSort} />
              <SortableTh col="corpTicker"     label="Corp"       sort={sort} onToggle={toggleSort} />
              <SortableTh col="allianceTicker" label="Alliance"   sort={sort} onToggle={toggleSort} />
              <SortableTh col="role"           label="Role"       sort={sort} onToggle={toggleSort} />
              <SortableTh col="blocked"        label="Status"     sort={sort} onToggle={toggleSort} />
              <SortableTh col="lastLogin"      label="Last login" sort={sort} onToggle={toggleSort} />
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {(sortedUsers ?? users).map((u) => {
              const isSelf = self?.id === u.id;
              const isBusy = busyId === u.id;
              return (
                <tr key={u.id} className={u.blocked ? 'admin-modal__tr--blocked' : ''}>
                  <td className="admin-modal__name-cell">
                    <img
                      className="admin-modal__avatar"
                      src={`https://images.evetech.net/characters/${u.characterId}/portrait?size=32`}
                      alt=""
                    />
                    <span>{u.characterName}</span>
                    {isSelf && <span className="admin-modal__self-tag">you</span>}
                  </td>
                  <td title={u.corpName ?? undefined}>
                    {u.corpTicker
                      ? <span className="admin-modal__ticker">[{u.corpTicker}]</span>
                      : <span className="admin-modal__mono">{u.corpId ?? '—'}</span>}
                  </td>
                  <td title={u.allianceName ?? undefined}>
                    {u.allianceTicker
                      ? <span className="admin-modal__ticker">[{u.allianceTicker}]</span>
                      : <span className="admin-modal__mono">—</span>}
                  </td>
                  <td>
                    {canEdit ? (
                      <select
                        className="admin-modal__role-select"
                        value={u.role}
                        disabled={isBusy || isSelf}
                        onChange={(e) => changeRole(u, e.target.value as Role)}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                      </select>
                    ) : (
                      <span className="admin-modal__mono">{u.role}</span>
                    )}
                  </td>
                  <td>
                    {u.blocked
                      ? <span className="admin-modal__pill admin-modal__pill--blocked">blocked</span>
                      : <span className="admin-modal__pill admin-modal__pill--ok">active</span>}
                  </td>
                  <td className="admin-modal__when">{formatRelative(u.lastLogin)}</td>
                  {canEdit && (
                    <td className="admin-modal__actions">
                      {u.blocked ? (
                        <button className="btn btn--ghost btn--sm" disabled={isBusy} onClick={() => setBlocked(u, false)}>
                          Unblock
                        </button>
                      ) : (
                        <button
                          className="btn btn--ghost btn--sm admin-modal__danger"
                          disabled={isBusy || isSelf}
                          onClick={() => setBlockTarget(u)}
                        >
                          Block
                        </button>
                      )}
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={isBusy}
                        onClick={() => recheckCorp(u)}
                        title="Re-query ESI for this user's current corp"
                      >
                        Recheck
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {blockTarget && (
        <ConfirmModal
          message={`Block ${blockTarget.characterName}? They'll be signed out at their next request.`}
          onCancel={() => setBlockTarget(null)}
          onConfirm={() => setBlocked(blockTarget, true)}
        />
      )}
    </>
  );
}

// ── Maps tab ────────────────────────────────────────────────────────────────

interface AdminMap {
  id:                  string;
  name:                string;
  corpId:              number | null;
  corpTicker:          string | null;
  corpName:            string | null;
  locked:              boolean;
  lastActiveAt:        string;
  createdAt:           string;
  ownerId:             number;
  ownerCharacterId:    number;
  ownerCharacterName:  string;
  systemCount:         number;
  connectionCount:     number;
}

function MapsTab() {
  const [maps, setMaps]   = useState<AdminMap[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminMap | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ maps: AdminMap[] }>('/api/admin/maps');
      setMaps(r.maps);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load maps');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function setLock(m: AdminMap, locked: boolean) {
    setBusyId(m.id);
    try {
      await api(`/api/admin/maps/${m.id}/${locked ? 'lock' : 'unlock'}`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lock change failed');
    } finally {
      setBusyId(null);
    }
  }

  async function destroy(m: AdminMap) {
    setBusyId(m.id);
    try {
      await api(`/api/admin/maps/${m.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <h2 className="admin-page__section-title">Maps</h2>
      {error && <div className="admin-page__error">{error}</div>}
      {!maps && !error && <div className="admin-page__loading">Loading…</div>}
      {maps && !maps.length && <div className="admin-page__empty">No maps yet.</div>}
      {maps && maps.length > 0 && (
        <table className="admin-modal__table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Owner</th>
              <th>Corp</th>
              <th>Systems</th>
              <th>Connections</th>
              <th>Lock</th>
              <th>Last active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {maps.map((m) => {
              const isBusy = busyId === m.id;
              return (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className="admin-modal__name-cell">
                    <img
                      className="admin-modal__avatar"
                      src={`https://images.evetech.net/characters/${m.ownerCharacterId}/portrait?size=32`}
                      alt=""
                    />
                    <span>{m.ownerCharacterName}</span>
                  </td>
                  <td title={m.corpName ?? undefined}>
                    {m.corpTicker
                      ? <span className="admin-modal__ticker">[{m.corpTicker}]</span>
                      : <span className="admin-modal__mono">{m.corpId}</span>}
                  </td>
                  <td className="admin-modal__num">{m.systemCount}</td>
                  <td className="admin-modal__num">{m.connectionCount}</td>
                  <td>
                    {m.locked
                      ? <span className="admin-modal__pill admin-modal__pill--blocked">locked</span>
                      : <span className="admin-modal__pill admin-modal__pill--ok">open</span>}
                  </td>
                  <td className="admin-modal__when">{formatRelative(m.lastActiveAt)}</td>
                  <td className="admin-modal__actions">
                    {m.locked ? (
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={isBusy}
                        onClick={() => setLock(m, false)}
                        title="Unfreeze the map; systems and connections become editable again"
                      >
                        Unlock
                      </button>
                    ) : (
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={isBusy}
                        onClick={() => setLock(m, true)}
                        title="Freeze systems and connections; signatures/structures/notes stay editable"
                      >
                        Lock
                      </button>
                    )}
                    <button
                      className="btn btn--ghost btn--sm admin-modal__danger"
                      disabled={isBusy}
                      onClick={() => setDeleteTarget(m)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {deleteTarget && (
        <ConfirmModal
          message={`Force-delete "${deleteTarget.name}" (owned by ${deleteTarget.ownerCharacterName})? This cannot be undone.`}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => destroy(deleteTarget)}
        />
      )}
    </>
  );
}

// ── Reports tab ─────────────────────────────────────────────────────────────

type ReportKind = 'users' | 'systems' | 'ghost-sites';

const REPORTS: { key: ReportKind; label: string }[] = [
  { key: 'users',       label: 'Users'       },
  { key: 'systems',     label: 'Systems'     },
  { key: 'ghost-sites', label: 'Ghost sites' },
];

type WindowKey = 'all' | '24h' | 'week' | 'month' | 'year';
const WINDOW_OPTIONS: { value: WindowKey; label: string }[] = [
  { value: 'all',   label: 'All time'   },
  { value: '24h',   label: 'Past 24 hours' },
  { value: 'week',  label: 'Past week'  },
  { value: 'month', label: 'Past month' },
  { value: 'year',  label: 'Past year'  },
];

// Match the server's bucket choice: 24h → hourly, week/month → daily,
// year/all → monthly. The chart title narrates whichever bucket is in play
// so admins aren't reading "per day" against monthly points.
function chartTitleFor(window: WindowKey): string {
  switch (window) {
    case '24h':   return 'Signatures per hour (past 24 hours)';
    case 'week':  return 'Signatures per day (past week)';
    case 'month': return 'Signatures per day (past month)';
    case 'year':  return 'Signatures per month (past year)';
    case 'all':   return 'Signatures per month (all time)';
  }
}

type UserFilterKey = 'all' | 'logins' | 'signatures' | 'structures';
const USER_FILTER_OPTIONS: { value: UserFilterKey; label: string }[] = [
  { value: 'all',        label: 'All users'   },
  { value: 'logins',     label: 'Logins'      },
  { value: 'signatures', label: 'Signatures'  },
  { value: 'structures', label: 'Structures'  },
];

function ReportsTab() {
  const [path, navigate] = useHashRoute();
  const { user } = useAuth();
  const canSeeReports = !!user?.canViewReports;
  const visibleReports = useMemo(
    () => REPORTS.filter((r) => r.key !== 'ghost-sites' || canSeeReports),
    [canSeeReports],
  );
  const kind = pathToReport(path, canSeeReports);

  return (
    <>
      <h2 className="admin-page__section-title">Reports</h2>
      <div className="admin-page__subtabs">
        {visibleReports.map((r) => (
          <button
            key={r.key}
            className={`admin-page__subtab${kind === r.key ? ' admin-page__subtab--active' : ''}`}
            onClick={() => navigate(`/admin/reports/${r.key}`)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {kind === 'users'       && <UsersReport />}
      {kind === 'systems'     && <SystemsReport />}
      {kind === 'ghost-sites' && canSeeReports && <GhostSitesReport />}
    </>
  );
}

function pathToReport(path: string, canSeeReports: boolean): ReportKind {
  if (path.startsWith('/admin/reports/systems'))                       return 'systems';
  if (path.startsWith('/admin/reports/ghost-sites') && canSeeReports)  return 'ghost-sites';
  return 'users';
}

// ── Users report ────────────────────────────────────────────────────────────

interface UserReportRow {
  id:                   number;
  characterId:          number;
  characterName:        string;
  role:                 Role;
  corpId:               number | null;
  corpTicker:           string | null;
  corpName:             string | null;
  allianceId:           number | null;
  allianceTicker:       string | null;
  allianceName:         string | null;
  lastLogin:            string | null;
  lastCorpSigAt:        string | null;
  lastCorpStructAt:     string | null;
  totalCorpStructures:  number;
  systemsAdded:         number;
  systemsDeleted:       number;
  sigTypeCounts:        Record<string, number>;
}

const SIG_TYPE_ORDER: { key: string; label: string }[] = [
  { key: 'data',     label: 'Data'     },
  { key: 'relic',    label: 'Relic'    },
  { key: 'wormhole', label: 'WH'       },
  { key: 'gas',      label: 'Gas'      },
  { key: 'ore',      label: 'Ore'      },
  { key: 'combat',   label: 'Combat'   },
  { key: 'unknown',  label: 'Unknown'  },
];

type UserReportFixedKey =
  | 'name' | 'corp' | 'alliance' | 'lastLogin' | 'lastCorpSig' | 'lastCorpStruct'
  | 'sigTotal' | 'structTotal' | 'systemsAdded' | 'systemsDeleted';
type UserReportSortKey  = UserReportFixedKey | `sig:${string}`;
type SortDir = 'asc' | 'desc';

// Sort accessors for the fixed columns. Sig-type columns are handled in
// userReportAccessor below — they pull out r.sigTypeCounts[<type>].
// Null timestamps sort to the end regardless of direction so unanswered
// users don't dominate the top of an ascending sort.
const USER_REPORT_FIXED_ACCESSORS: Record<UserReportFixedKey, (r: UserReportRow) => string | number | null> = {
  name:           (r) => r.characterName.toLowerCase(),
  corp:           (r) => r.corpTicker     ?? (r.corpId     !== null ? String(r.corpId)     : ''),
  alliance:       (r) => r.allianceTicker ?? (r.allianceId !== null ? String(r.allianceId) : ''),
  lastLogin:      (r) => r.lastLogin        ? new Date(r.lastLogin).getTime()        : null,
  lastCorpSig:    (r) => r.lastCorpSigAt    ? new Date(r.lastCorpSigAt).getTime()    : null,
  lastCorpStruct: (r) => r.lastCorpStructAt ? new Date(r.lastCorpStructAt).getTime() : null,
  sigTotal:       (r) => Object.values(r.sigTypeCounts).reduce((a, b) => a + b, 0),
  structTotal:    (r) => r.totalCorpStructures,
  systemsAdded:   (r) => r.systemsAdded,
  systemsDeleted: (r) => r.systemsDeleted,
};

function userReportAccessor(key: UserReportSortKey, row: UserReportRow): string | number | null {
  if (key.startsWith('sig:')) {
    const type = key.slice(4);
    return row.sigTypeCounts[type] ?? 0;
  }
  return USER_REPORT_FIXED_ACCESSORS[key as UserReportFixedKey](row);
}

function compareValues(a: string | number | null, b: string | number | null, dir: SortDir): number {
  // Nulls always sink to the bottom regardless of direction.
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const cmp = a < b ? -1 : a > b ? 1 : 0;
  return dir === 'asc' ? cmp : -cmp;
}

function UsersReport() {
  const [rows, setRows]   = useState<UserReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort]   = useState<{ key: UserReportSortKey; dir: SortDir }>({ key: 'name', dir: 'asc' });
  const [filter, setFilter] = useState<UserFilterKey>('all');
  const [window, setWindow] = useState<WindowKey>('all');

  useEffect(() => {
    setRows(null);
    setError(null);
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('filter', filter);
    if (window !== 'all') params.set('window', window);
    const qs = params.toString();
    api<{ users: UserReportRow[] }>(`/api/admin/reports/users${qs ? `?${qs}` : ''}`)
      .then((r) => setRows(r.users))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load users report'));
  }, [filter, window]);

  const sortedRows = useMemo(() => {
    if (!rows) return null;
    return [...rows].sort((a, b) =>
      compareValues(userReportAccessor(sort.key, a), userReportAccessor(sort.key, b), sort.dir));
  }, [rows, sort]);

  // Headline counts over the currently-filtered set. Unique corps/alliances
  // count distinct non-null IDs, so users with no corp/alliance don't inflate.
  const summary = useMemo(() => {
    if (!rows) return { users: 0, corps: 0, alliances: 0 };
    const corps = new Set<number>();
    const alliances = new Set<number>();
    for (const u of rows) {
      if (u.corpId !== null) corps.add(u.corpId);
      if (u.allianceId !== null) alliances.add(u.allianceId);
    }
    return { users: rows.length, corps: corps.size, alliances: alliances.size };
  }, [rows]);

  function handleSort(key: UserReportSortKey) {
    setSort((prev) => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: defaultDirFor(key) });
  }

  function downloadCsv() {
    if (!sortedRows) return;
    const header = [
      'Character', 'Character ID', 'Corp ticker', 'Corp ID', 'Alliance ticker', 'Alliance ID', 'Role',
      'Last login (ISO)',
      'Systems added', 'Systems deleted',
      'Last corp structure (ISO)', 'Total structures',
      'Last corp signature (ISO)', 'Total signatures',
      ...SIG_TYPE_ORDER.map((t) => t.label),
    ];
    const rows = sortedRows.map((u) => {
      const total = Object.values(u.sigTypeCounts).reduce((a, b) => a + b, 0);
      return [
        u.characterName,
        String(u.characterId),
        u.corpTicker ?? '',
        u.corpId !== null ? String(u.corpId) : '',
        u.allianceTicker ?? '',
        u.allianceId !== null ? String(u.allianceId) : '',
        u.role,
        u.lastLogin        ?? '',
        String(u.systemsAdded),
        String(u.systemsDeleted),
        u.lastCorpStructAt ?? '',
        String(u.totalCorpStructures),
        u.lastCorpSigAt    ?? '',
        String(total),
        ...SIG_TYPE_ORDER.map((t) => String(u.sigTypeCounts[t.key] ?? 0)),
      ];
    });
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `nexum_users_report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const controls = (
    <div className="admin-page__filter-bar">
      <div className="admin-page__filter-group">
        <label className="admin-page__filter-label">Filter</label>
        <select
          className="admin-modal__role-select"
          value={filter}
          onChange={(e) => setFilter(e.target.value as UserFilterKey)}
        >
          {USER_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="admin-page__filter-group">
        <label className="admin-page__filter-label">Window</label>
        <select
          className="admin-modal__role-select"
          value={window}
          onChange={(e) => setWindow(e.target.value as WindowKey)}
          disabled={filter === 'all'}
          title={filter === 'all' ? 'Pick a filter to apply a window' : ''}
        >
          {WINDOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      <div className="admin-page__filter-spacer" />
      {sortedRows && sortedRows.length > 0 && (
        <button className="btn btn--ghost btn--sm" onClick={downloadCsv}>
          ↓ Export as CSV
        </button>
      )}
    </div>
  );

  if (error) return <>{controls}<div className="admin-page__error">{error}</div></>;
  if (!sortedRows) return <>{controls}<div className="admin-page__loading">Loading…</div></>;
  if (!sortedRows.length) return <>{controls}<div className="admin-page__empty">No users match the current filter.</div></>;

  return (
    <>
    {controls}
    <div className="admin-page__stat-grid">
      <StatCard label="Total users"      value={summary.users}     accent />
      <StatCard label="Unique corps"     value={summary.corps} />
      <StatCard label="Unique alliances" value={summary.alliances} />
    </div>
    <table className="admin-modal__table admin-page__sortable">
      <thead>
        <tr>
          <SortHeader label="Character"          colKey="name"           sort={sort} onSort={handleSort} />
          <SortHeader label="Corp"               colKey="corp"           sort={sort} onSort={handleSort} />
          <SortHeader label="Alliance"           colKey="alliance"       sort={sort} onSort={handleSort} />
          <SortHeader label="Last login"           colKey="lastLogin"      sort={sort} onSort={handleSort} />
          <SortHeader label="Systems added"        colKey="systemsAdded"   sort={sort} onSort={handleSort} />
          <SortHeader label="Systems deleted"      colKey="systemsDeleted" sort={sort} onSort={handleSort} />
          <SortHeader label="Last corp structure"  colKey="lastCorpStruct" sort={sort} onSort={handleSort} />
          <SortHeader label="Total structures"     colKey="structTotal"    sort={sort} onSort={handleSort} />
          <SortHeader label="Last corp signature"  colKey="lastCorpSig"    sort={sort} onSort={handleSort} />
          <SortHeader label="Total signatures"     colKey="sigTotal"       sort={sort} onSort={handleSort} />
          {SIG_TYPE_ORDER.map((t) => (
            <SortHeader
              key={t.key}
              label={t.label}
              colKey={`sig:${t.key}` as UserReportSortKey}
              sort={sort}
              onSort={handleSort}
              align="center"
            />
          ))}
        </tr>
      </thead>
      <tbody>
        {sortedRows.map((u) => {
          const total = Object.values(u.sigTypeCounts).reduce((a, b) => a + b, 0);
          return (
            <tr key={u.id}>
              <td className="admin-modal__name-cell">
                <img
                  className="admin-modal__avatar"
                  src={`https://images.evetech.net/characters/${u.characterId}/portrait?size=32`}
                  alt=""
                />
                <span>{u.characterName}</span>
              </td>
              <td title={u.corpName ?? undefined}>
                {u.corpTicker
                  ? <span className="admin-modal__ticker">[{u.corpTicker}]</span>
                  : <span className="admin-modal__mono">{u.corpId ?? '—'}</span>}
              </td>
              <td title={u.allianceName ?? undefined}>
                {u.allianceTicker
                  ? <span className="admin-modal__ticker">[{u.allianceTicker}]</span>
                  : u.allianceId !== null
                    ? <span className="admin-modal__mono">{u.allianceId}</span>
                    : '—'}
              </td>
              <td className="admin-modal__when">{u.lastLogin ? formatRelative(u.lastLogin) : '—'}</td>
              <td className="admin-modal__num">{u.systemsAdded   > 0 ? u.systemsAdded   : '—'}</td>
              <td className="admin-modal__num">{u.systemsDeleted > 0 ? u.systemsDeleted : '—'}</td>
              <td className="admin-modal__when">{u.lastCorpStructAt ? formatRelative(u.lastCorpStructAt) : '—'}</td>
              <td className="admin-modal__num">{u.totalCorpStructures > 0 ? u.totalCorpStructures : '—'}</td>
              <td className="admin-modal__when">{u.lastCorpSigAt ? formatRelative(u.lastCorpSigAt) : '—'}</td>
              <td className="admin-modal__num">{total > 0 ? total : '—'}</td>
              {SIG_TYPE_ORDER.map((t) => {
                const n = u.sigTypeCounts[t.key] ?? 0;
                return (
                  <td key={t.key} className="admin-modal__num--center">
                    {n > 0 ? n : <span className="admin-modal__mono">—</span>}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
    </>
  );
}

// Names / corp default to ascending; time + count columns (including each
// per-sig-type column) default to descending — that's what an admin usually
// wants on first click.
function defaultDirFor(key: UserReportSortKey): SortDir {
  return key === 'name' || key === 'corp' || key === 'alliance' ? 'asc' : 'desc';
}

function SortHeader<K extends string>({
  label, colKey, sort, onSort, align,
}: {
  label: string;
  colKey: K;
  sort: { key: K; dir: SortDir };
  onSort: (key: K) => void;
  align?: 'center';
}) {
  const active = sort.key === colKey;
  const cls =
    'admin-page__sort-th' +
    (active ? ' admin-page__sort-th--active' : '') +
    (align === 'center' ? ' admin-page__sort-th--center' : '');
  return (
    <th className={cls} onClick={() => onSort(colKey)}>
      <span>{label}</span>
      <span className="admin-page__sort-arrow">
        {active && (sort.dir === 'asc'
          ? <CaretUpIcon   size={12} weight="bold" />
          : <CaretDownIcon size={12} weight="bold" />)}
      </span>
    </th>
  );
}

// ── Systems report ──────────────────────────────────────────────────────────

interface SystemsReportData {
  total:           number;
  byType:          Record<string, number>;
  byWormholeType:  Array<{ whType: string; count: number }>;
  dailyTotals:     Array<{ day: string; count: number }>;
}

// Stable palette for the sig-type donut so colours don't shuffle on refresh.
const SIG_TYPE_COLORS: Record<string, string> = {
  data:     '#7ab4f0',
  relic:    '#f0a8c0',
  wormhole: '#c084fc',
  gas:      '#8ad08a',
  ore:      '#f5b96a',
  combat:   '#f87171',
  unknown:  '#7a8aa8',
};

type WhSortKey = 'whType' | 'count';

function SystemsReport() {
  const [data, setData]   = useState<SystemsReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whSort, setWhSort] = useState<{ key: WhSortKey; dir: SortDir }>({ key: 'count', dir: 'desc' });
  const [window, setWindow] = useState<WindowKey>('month');

  useEffect(() => {
    setData(null);
    setError(null);
    const qs = window === 'all' ? '' : `?window=${window}`;
    api<SystemsReportData>(`/api/admin/reports/systems${qs}`)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load systems report'));
  }, [window]);

  const sortedWh = useMemo(() => {
    if (!data) return null;
    const accessor = whSort.key === 'count'
      ? (r: { whType: string; count: number }) => r.count
      : (r: { whType: string; count: number }) => r.whType;
    return [...data.byWormholeType].sort((a, b) => compareValues(accessor(a), accessor(b), whSort.dir));
  }, [data, whSort]);

  function handleWhSort(key: WhSortKey) {
    setWhSort((prev) => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'count' ? 'desc' : 'asc' });
  }

  const controls = (
    <div className="admin-page__filter-bar">
      <div className="admin-page__filter-group">
        <label className="admin-page__filter-label">Window</label>
        <select
          className="admin-modal__role-select"
          value={window}
          onChange={(e) => setWindow(e.target.value as WindowKey)}
        >
          {WINDOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
    </div>
  );

  if (error) return <>{controls}<div className="admin-page__error">{error}</div></>;
  if (!data || !sortedWh) return <>{controls}<div className="admin-page__loading">Loading…</div></>;
  if (data.total === 0) return <>{controls}<div className="admin-page__empty">No signatures in this window.</div></>;

  const donutEntries = SIG_TYPE_ORDER
    .map((t) => ({ key: t.key, label: t.label, count: data.byType[t.key] ?? 0 }))
    .filter((e) => e.count > 0);

  return (
    <>
      {controls}
      <h3 className="admin-page__report-heading">Signatures across all maps</h3>
      <div className="admin-page__stat-grid">
        <StatCard label="Total" value={data.total} accent />
        {SIG_TYPE_ORDER.map((t) => {
          const count = data.byType[t.key] ?? 0;
          return (
            <StatCard
              key={t.key}
              label={t.label}
              value={count}
              pct={data.total > 0 ? (count / data.total) * 100 : 0}
            />
          );
        })}
      </div>

      <div className="admin-page__chart-row">
        <div className="admin-page__chart-card">
          <div className="admin-page__chart-title">Signature type mix</div>
          <div className="admin-page__chart-canvas">
            <Doughnut
              data={{
                labels:   donutEntries.map((e) => e.label),
                datasets: [{
                  data: donutEntries.map((e) => e.count),
                  backgroundColor: donutEntries.map((e) => SIG_TYPE_COLORS[e.key] ?? '#7a8aa8'),
                  borderColor: '#0d1117',
                  borderWidth: 2,
                }],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                cutout: '60%',
                plugins: {
                  legend: { position: 'right', labels: { color: '#c0ccde', boxWidth: 12 } },
                  tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${ctx.parsed}` } },
                },
              }}
            />
          </div>
        </div>

        <div className="admin-page__chart-card">
          <div className="admin-page__chart-title">{chartTitleFor(window)}</div>
          <div className="admin-page__chart-canvas">
            <Line
              data={{
                labels: data.dailyTotals.map((d) => d.day),
                datasets: [{
                  label:           'Signatures',
                  data:            data.dailyTotals.map((d) => d.count),
                  borderColor:     '#7ab4f0',
                  backgroundColor: 'rgba(122,180,240,0.12)',
                  pointBackgroundColor: '#7ab4f0',
                  pointRadius: 2,
                  pointHoverRadius: 4,
                  tension: 0.25,
                  fill: true,
                }],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend:  { display: false },
                  tooltip: { mode: 'index', intersect: false },
                },
                scales: {
                  x: {
                    ticks: { color: '#7a8aa8', maxRotation: 0, autoSkipPadding: 12 },
                    grid:  { color: '#1e2740' },
                  },
                  y: {
                    beginAtZero: true,
                    ticks: { color: '#7a8aa8', precision: 0 },
                    grid:  { color: '#1e2740' },
                  },
                },
              }}
            />
          </div>
        </div>
      </div>

      <h3 className="admin-page__report-heading">Wormhole types</h3>
      {sortedWh.length === 0 ? (
        <div className="admin-page__empty">No wormhole signatures with a recorded type yet.</div>
      ) : (
        <table className="admin-modal__table admin-page__sortable admin-page__wh-table">
          <thead>
            <tr>
              <SortHeader label="Type"  colKey="whType" sort={whSort} onSort={handleWhSort} />
              <SortHeader label="Count" colKey="count"  sort={whSort} onSort={handleWhSort} />
            </tr>
          </thead>
          <tbody>
            {sortedWh.map((row) => (
              <tr key={row.whType}>
                <td className="admin-modal__mono">{row.whType}</td>
                <td className="admin-modal__num">{row.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function StatCard({ label, value, accent = false, pct }: { label: string; value: number; accent?: boolean; pct?: number | null }) {
  return (
    <div className={`admin-page__stat-card${accent ? ' admin-page__stat-card--accent' : ''}`}>
      <span className="admin-page__stat-card-value">{value.toLocaleString()}</span>
      {pct != null && <span className="admin-page__stat-card-pct">{pct.toFixed(1)}%</span>}
      <span className="admin-page__stat-card-label">{label}</span>
    </div>
  );
}

// ── Ghost sites report ──────────────────────────────────────────────────────

interface GhostSiteRow {
  eveSystemId:       number;
  systemName:        string;
  constellationName: string | null;
  regionName:        string | null;
  systemClass:       string;
  sunType:           string | null;
  planetCount:       number | null;
  moonCount:         number | null;
  observations:      number;
  firstSeenAt:       string;
  lastSeenAt:        string;
}

type GhostSortKey =
  | 'region' | 'constellation' | 'system' | 'class'
  | 'sunType' | 'planets' | 'moons' | 'observations' | 'lastSeen';

const GHOST_ACCESSORS: Record<GhostSortKey, (r: GhostSiteRow) => string | number | null> = {
  region:        (r) => r.regionName?.toLowerCase()        ?? null,
  constellation: (r) => r.constellationName?.toLowerCase() ?? null,
  system:        (r) => r.systemName.toLowerCase(),
  class:         (r) => r.systemClass,
  sunType:       (r) => r.sunType?.toLowerCase() ?? null,
  planets:       (r) => r.planetCount  ?? null,
  moons:         (r) => r.moonCount    ?? null,
  observations:  (r) => r.observations,
  lastSeen:      (r) => new Date(r.lastSeenAt).getTime(),
};

function GhostSitesReport() {
  const [rows, setRows]   = useState<GhostSiteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort]   = useState<{ key: GhostSortKey; dir: SortDir }>({ key: 'region', dir: 'asc' });

  useEffect(() => {
    api<{ rows: GhostSiteRow[] }>('/api/admin/reports/ghost-sites')
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load ghost sites report'));
  }, []);

  const sorted = useMemo(() => {
    if (!rows) return null;
    const acc = GHOST_ACCESSORS[sort.key];
    return [...rows].sort((a, b) => compareValues(acc(a), acc(b), sort.dir));
  }, [rows, sort]);

  function onSort(key: GhostSortKey) {
    setSort((prev) => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'observations' || key === 'lastSeen' ? 'desc' : 'asc' });
  }

  if (error)   return <div className="admin-page__error">{error}</div>;
  if (!sorted) return <div className="admin-page__loading">Loading…</div>;

  return (
    <>
      <h3 className="admin-page__report-heading">Covert Research Facility observations</h3>
      {sorted.length === 0 ? (
        <div className="admin-page__empty">No K-space ghost sites recorded yet.</div>
      ) : (
        <table className="admin-modal__table admin-page__sortable">
          <thead>
            <tr>
              <SortHeader label="Region"        colKey="region"        sort={sort} onSort={onSort} />
              <SortHeader label="Constellation" colKey="constellation" sort={sort} onSort={onSort} />
              <SortHeader label="System"        colKey="system"        sort={sort} onSort={onSort} />
              <SortHeader label="Class"         colKey="class"         sort={sort} onSort={onSort} />
              <SortHeader label="Sun"           colKey="sunType"       sort={sort} onSort={onSort} />
              <SortHeader label="Planets"       colKey="planets"       sort={sort} onSort={onSort} />
              <SortHeader label="Moons"         colKey="moons"         sort={sort} onSort={onSort} />
              <SortHeader label="Observations"  colKey="observations"  sort={sort} onSort={onSort} />
              <SortHeader label="Last seen"     colKey="lastSeen"      sort={sort} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.eveSystemId}>
                <td>{r.regionName        ?? '—'}</td>
                <td>{r.constellationName ?? '—'}</td>
                <td className="admin-modal__mono">{r.systemName}</td>
                <td>{r.systemClass}</td>
                <td>{r.sunType     ?? '—'}</td>
                <td className="admin-modal__num">{r.planetCount ?? '—'}</td>
                <td className="admin-modal__num">{r.moonCount   ?? '—'}</td>
                <td className="admin-modal__num">{r.observations}</td>
                <td>{new Date(r.lastSeenAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── Audit tab ───────────────────────────────────────────────────────────────

interface AuditEntry {
  id:                  number;
  createdAt:           string;
  action:              string;
  oldValue:            string | null;
  newValue:            string | null;
  actorCharacterId:    number | null;
  actorCharacterName:  string | null;
  targetCharacterId:   number | null;
  targetCharacterName: string | null;
}

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    api<{ entries: AuditEntry[] }>('/api/admin/audit')
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load audit log'));
  }, []);

  function downloadCsv() {
    if (!entries) return;
    const header = ['When (ISO)', 'Actor', 'Actor character ID', 'Action', 'Target', 'Target character ID', 'Old value', 'New value'];
    const rows = entries.map((e) => [
      e.createdAt,
      e.actorCharacterName ?? '',
      e.actorCharacterId !== null ? String(e.actorCharacterId) : '',
      e.action,
      e.targetCharacterName ?? '',
      e.targetCharacterId !== null ? String(e.targetCharacterId) : '',
      e.oldValue ?? '',
      e.newValue ?? '',
    ]);
    const csv = [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `nexum_audit_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="admin-page__section-bar">
        <h2 className="admin-page__section-title">Audit log</h2>
        {entries && entries.length > 0 && (
          <button className="btn btn--ghost btn--sm" onClick={downloadCsv}>
            ↓ Export as CSV
          </button>
        )}
      </div>
      {error && <div className="admin-page__error">{error}</div>}
      {!entries && !error && <div className="admin-page__loading">Loading…</div>}
      {entries && !entries.length && <div className="admin-page__empty">No admin actions yet.</div>}
      {entries && entries.length > 0 && (
        <table className="admin-modal__table">
          <thead>
            <tr>
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className="admin-modal__when">{formatRelative(e.createdAt)}</td>
                <td>{e.actorCharacterName ?? '—'}</td>
                <td><span className="admin-modal__action">{e.action}</span></td>
                <td>{e.targetCharacterName ?? '—'}</td>
                <td className="admin-modal__mono">
                  {e.oldValue ?? '∅'} → {e.newValue ?? '∅'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const then = date.getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.floor((Date.now() - then) / 1000);
  if (secs < 60)              return `${secs}s ago`;
  if (secs < 3600)            return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400)           return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 86400 * 30)      return `${Math.floor(secs / 86400)}d ago`;
  // Anything older than ~a month is more useful as an absolute European
  // date (DD-MM-YYYY) than "65d ago".
  return formatEuropeanDate(date);
}

function formatEuropeanDate(date: Date): string {
  const dd   = String(date.getDate()).padStart(2, '0');
  const mm   = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

// RFC 4180 CSV escaping: wrap in double quotes if the field contains a
// comma, quote, CR, or LF, doubling any embedded quotes.
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}
