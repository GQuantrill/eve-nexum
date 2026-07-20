import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { charPortrait } from '../../utils/eveImages';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api, ApiError } from '../../api/client';
import { toast } from './Toaster';
import { useAuth, isAdminRole, isAllianceAdminRole, formatRole, ROLE_ORDER } from '../../context/AuthContext';
import type { Role as AuthRole } from '../../context/AuthContext';
import { useHashRoute } from '../../hooks/useHashRoute';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useWormholeTypes } from '../../hooks/useWormholeTypes';
import { cssVarToHex } from '../../utils/cssVar';
import { timeAgo, europeanDate, DASH } from '../../i18n/format';
import { ConfirmModal } from './ConfirmModal';
import { StandingsViewerModal } from './StandingsViewerModal';
import {
  Chart as ChartJS,
  ArcElement, CategoryScale, LinearScale,
  PointElement, LineElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { Doughnut, Line } from 'react-chartjs-2';
import { CaretUpIcon, CaretDownIcon, XIcon, ArrowSquareOutIcon } from '@phosphor-icons/react';
import { createPortal } from 'react-dom';
import styles from './AdminPage.module.css';

// Register only the chart pieces we actually use — keeps the bundle lean.
ChartJS.register(ArcElement, CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

type Role = 'alliance_admin' | 'admin' | 'full' | 'edit' | 'readonly';
const ROLES: Role[] = ['alliance_admin', 'admin', 'full', 'edit', 'readonly'];

// Explainer modal for the role tiers, opened from the "Roles?" button on the
// users tab. The alliance tier is only listed when the deployment uses it.
function RolesInfoModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const roles = ROLE_ORDER.filter((r) => r !== 'alliance_admin' || user?.allianceMode);
  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${styles.rolesModal}`} role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('admin.roles.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>
        <div className="modal__body">
          <dl className={styles.rolesInfo}>
            {roles.map((r) => (
              <div key={r} className={styles.rolesInfoRow}>
                <dt><span className={`role-badge role-badge--${r}`}>{formatRole(r)}</span></dt>
                <dd>{t(`admin.roles.desc.${r}`)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type Tab = 'users' | 'access' | 'maps' | 'reports' | 'audit' | 'discord';

const ALL_TABS: { key: Tab; path: string }[] = [
  { key: 'users',   path: '/admin/users'   },
  { key: 'access',  path: '/admin/access'  },
  { key: 'maps',    path: '/admin/maps'    },
  { key: 'reports', path: '/admin/reports' },
  { key: 'discord', path: '/admin/discord' },
  { key: 'audit',   path: '/admin/audit'   },
];

export function AdminPage() {
  const { t } = useTranslation();
  const [path, navigate] = useHashRoute();
  const { user } = useAuth();
  const isAdmin = !!user && isAdminRole(user.role);
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
    <div className={styles.adminPage}>
      <aside className={styles.pgNav}>
        <button className={styles.pgBack} onClick={() => navigate('/')}>← {t('admin.back')}</button>
        <h1 className={styles.pgTitle}>{t('admin.title')}</h1>
        <nav className={styles.pgTabs}>
          {tabs.map((tb) => (
            <button
              key={tb.key}
              className={[styles.pgTab, tab === tb.key && styles.pgTabActive].filter(Boolean).join(' ')}
              onClick={() => navigate(tb.path)}
            >
              {t(`admin.tabs.${tb.key}`)}
            </button>
          ))}
        </nav>
      </aside>

      <main className={styles.pgContent}>
        {tab === 'users'   && (isAdmin || canSeeReports) && <UsersTab />}
        {tab === 'access'  && isAdmin       && <AccessTab />}
        {tab === 'maps'    && isAdmin       && <MapsTab />}
        {tab === 'reports' && (isAdmin || canSeeReports) && <ReportsTab />}
        {tab === 'discord' && isAdmin       && <DiscordTab />}
        {tab === 'audit'   && isAdmin       && <AuditTab />}
      </main>
    </div>
  );
}

function pathToTab(path: string, isAdmin: boolean, canSeeReports: boolean): Tab {
  const fallback: Tab = isAdmin || canSeeReports ? 'users' : 'reports';
  if (path.startsWith('/admin/access'))  return isAdmin       ? 'access'  : fallback;
  if (path.startsWith('/admin/maps'))    return isAdmin       ? 'maps'    : fallback;
  if (path.startsWith('/admin/reports')) return (isAdmin || canSeeReports) ? 'reports' : fallback;
  if (path.startsWith('/admin/discord')) return isAdmin       ? 'discord' : fallback;
  if (path.startsWith('/admin/audit'))   return isAdmin       ? 'audit'   : fallback;
  return fallback;
}

// ── Access allow-list tab ─────────────────────────────────────────────────────

interface AccessGrant {
  id:          string;
  kind:        'corp' | 'alliance' | 'character';
  eveId:       number;
  source:      string;
  note:        string | null;
  addedByName: string | null;
  createdAt:   string;
  label:       string;
  immutable:   boolean;
}

// Turn an access-grant API failure into the clearest message we can show: a
// translated string for known server codes, otherwise the server's own
// `message` (so the operator sees WHY, not just "failed"), and only then a
// generic fallback.
function grantErrorMessage(e: unknown, t: TFunction, fallback: string): string {
  const code = e instanceof ApiError ? e.code : undefined;
  if (code === 'standing_not_positive')  return t('admin.access.errStanding');
  if (code === 'already_granted')        return t('admin.access.errDuplicate');
  if (code === 'alliance_not_supported') return t('admin.access.errAllianceUnsupported');
  const serverMsg = e instanceof ApiError ? e.serverMessage : undefined;
  return serverMsg && serverMsg.trim() ? serverMsg : fallback;
}

type GrantPickKind = 'corp' | 'alliance' | 'character';

// eveWho profile URL for a corp / alliance / character grant target.
function eveWhoUrl(kind: 'corp' | 'alliance' | 'character', id: number): string {
  const seg = kind === 'corp' ? 'corporation' : kind === 'alliance' ? 'alliance' : 'character';
  return `https://evewho.com/${seg}/${id}`;
}

// Small external-link icon to an entity's eveWho profile.
function EveWhoLink({ kind, id, t }: { kind: 'corp' | 'alliance' | 'character'; id: number; t: TFunction }) {
  return (
    <a
      className={styles.acEvewho}
      href={eveWhoUrl(kind, id)}
      target="_blank"
      rel="noreferrer"
      title={t('admin.access.eveWho')}
      aria-label={t('admin.access.eveWho')}
    >
      <ArrowSquareOutIcon size={13} weight="bold" />
    </a>
  );
}

const SEARCH_ENDPOINT: Record<GrantPickKind, string> = {
  character: '/api/search/characters',
  corp:      '/api/search/corporations',
  alliance:  '/api/search/alliances',
};

function AccessTab() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Alliance targets are offered in any restricted deployment now (a corp install
  // can admit an alliance, gated on the corp's own standing toward it).
  const allowAlliance = !!user?.corpMode || !!user?.allianceMode;
  const KINDS: GrantPickKind[] = allowAlliance ? ['corp', 'alliance', 'character'] : ['corp', 'character'];

  const [grants, setGrants]   = useState<AccessGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const [kind, setKind]           = useState<GrantPickKind>('corp');
  const [query, setQuery]         = useState('');
  const [match, setMatch]         = useState<{ id: number; name: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError]   = useState<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [syncing, setSyncing]       = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showStandings, setShowStandings] = useState(false);

  // Standings auto-admit ("friends") settings — off by default.
  const [stdEnabled, setStdEnabled]     = useState(false);
  const [stdThreshold, setStdThreshold] = useState<5 | 10>(10);

  const saveStandingsSettings = async (patch: { enabled?: boolean; threshold?: 5 | 10 }) => {
    if (patch.enabled !== undefined) setStdEnabled(patch.enabled);
    if (patch.threshold !== undefined) setStdThreshold(patch.threshold);
    try {
      const r = await api<{ sessionsKilled?: number }>('/api/admin/access-settings', { method: 'PATCH', body: JSON.stringify(patch) });
      if (r.sessionsKilled && r.sessionsKilled > 0) {
        toast.info(t('admin.access.standingsSessionsEnded', { count: r.sessionsKilled }));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.access.settingsSaveFailed'));
      void load(); // reconcile with the server's real state
    }
  };

  // Force-refresh the deployment's standings from ESI using the admin's own
  // token (one call does character + corp + alliance). The positive-standing
  // gate reads whichever bucket matches the install type, so we report on that.
  const syncStandings = async () => {
    setSyncing(true); setSyncResult(null);
    try {
      // scope:'org' — access control only ever uses corp/alliance standings, so
      // the access-page sync pulls ONLY the corp + alliance contact lists. It
      // deliberately does not touch personal contacts (that's the map's tint,
      // refreshed from the system-info panel instead).
      const r = await api<{ counts: Record<string, number>; succeeded: Record<string, boolean>; sessionsKilled?: number }>(
        '/api/standings/refresh', { method: 'POST', body: JSON.stringify({ scope: 'org' }) },
      );
      // Report on the bucket the gate actually reads: alliance_standings on an
      // alliance install, else the corp's OWN contacts (which include any
      // alliance standings). NOT allowAlliance — a corp install offers alliance
      // targets but still gates via the corp's contacts.
      const bucket = user?.allianceMode ? 'alliance' : 'corp';
      setSyncResult(r.succeeded[bucket]
        ? { ok: true,  text: t('admin.access.syncOk', { count: r.counts[bucket] ?? 0 }) }
        : { ok: false, text: t('admin.access.syncNoRole') });
      // The sync re-checks live sessions against the freshly-pulled standings and
      // evicts anyone no longer permitted — surface that, same as the settings flow.
      if (r.sessionsKilled && r.sessionsKilled > 0) {
        toast.info(t('admin.access.standingsSessionsEnded', { count: r.sessionsKilled }));
      }
    } catch (e) {
      setSyncResult({ ok: false, text: grantErrorMessage(e, t, t('admin.access.syncFailed')) });
    } finally { setSyncing(false); }
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [g, s] = await Promise.all([
        api<AccessGrant[]>('/api/admin/access-grants'),
        api<{ standingsLoginEnabled: boolean; standingsLoginThreshold: number }>('/api/admin/access-settings'),
      ]);
      setGrants(g);
      setStdEnabled(s.standingsLoginEnabled);
      setStdThreshold(s.standingsLoginThreshold === 5 ? 5 : 10);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.access.loadFailed'));
    } finally { setLoading(false); }
  }, [t]);
  useEffect(() => { load(); }, [load]);

  // Debounced exact-name lookup for the currently-selected kind.
  useEffect(() => {
    setMatch(null); setAddError(null);
    const q = query.trim();
    if (q.length < 3) { setSearching(false); return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      api<{ match: { id: number; name: string } | null }>(`${SEARCH_ENDPOINT[kind]}?q=${encodeURIComponent(q)}`)
        .then((r) => setMatch(r.match))
        .catch(() => setMatch(null))
        .finally(() => setSearching(false));
    }, 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query, kind]);

  const addGrant = async () => {
    if (!match) return;
    setSubmitting(true); setAddError(null);
    try {
      await api('/api/admin/access-grants', { method: 'POST', body: JSON.stringify({ kind, eveId: match.id }) });
      setQuery(''); setMatch(null);
      await load();
    } catch (e) {
      setAddError(grantErrorMessage(e, t, t('admin.access.addFailed')));
    } finally { setSubmitting(false); }
  };

  const removeGrant = async (g: AccessGrant) => {
    if (g.immutable) return;
    try {
      await api(`/api/admin/access-grants/${g.id}`, { method: 'DELETE' });
      await load();
    } catch (e) {
      setError(grantErrorMessage(e, t, t('admin.access.removeFailed')));
    }
  };

  return (
    <div className="admin-access">
      <h2 className={styles.pgSectionTitle}>{t('admin.access.title')}</h2>
      <p className={styles.acIntro}>{t('admin.access.intro')}</p>
      <div className={styles.acNote}>{t('admin.access.readonlyNote')}</div>

      <div className={styles.acStandings}>
        <label className={styles.acToggle}>
          <input type="checkbox" checked={stdEnabled} onChange={(e) => saveStandingsSettings({ enabled: e.target.checked })} />
          <span>{t('admin.access.standingsEnable')}</span>
        </label>
        <p className={styles.acHint}>{t('admin.access.standingsHint')}</p>
        {stdEnabled && (
          <div className={styles.acThreshold}>
            <span className={styles.acThresholdLabel}>{t('admin.access.standingsMinLevel')}</span>
            <label>
              <input type="radio" name="std-threshold" checked={stdThreshold === 10} onChange={() => saveStandingsSettings({ threshold: 10 })} />
              {t('admin.access.threshold10')}
            </label>
            <label>
              <input type="radio" name="std-threshold" checked={stdThreshold === 5} onChange={() => saveStandingsSettings({ threshold: 5 })} />
              {t('admin.access.threshold5')}
            </label>
          </div>
        )}
      </div>

      <div className={styles.acSync}>
        <div className={styles.acToolbar}>
          <button type="button" className="btn btn--ghost btn--sm" disabled={syncing} onClick={syncStandings}>
            {syncing ? t('admin.access.syncing') : t('admin.access.syncStandings')}
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowStandings(true)}>
            {t('admin.access.viewStandings')}
          </button>
          {syncResult && (
            <span className={[styles.acSyncStatus, !syncResult.ok && styles.acSyncStatusErr].filter(Boolean).join(' ')}>
              {syncResult.text}
            </span>
          )}
        </div>
        <p className={styles.acHint}>{t('admin.access.syncHint')}</p>
        <p className={styles.acHint}>{t('admin.access.syncDelay')}</p>
      </div>

      {showStandings && <StandingsViewerModal onClose={() => setShowStandings(false)} />}

      <div className={styles.acAdd}>
        <select
          className={styles.acKind}
          value={kind}
          onChange={(e) => { setKind(e.target.value as GrantPickKind); setMatch(null); setQuery(''); }}
        >
          {KINDS.map((k) => <option key={k} value={k}>{t(`admin.access.kind_${k}`)}</option>)}
        </select>
        <input
          className={styles.acInput}
          placeholder={t(`admin.access.placeholder_${kind}`)}
          value={query}
          maxLength={50}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className={[styles.acMatch, match && styles.acMatchOk].filter(Boolean).join(' ')}>
          {query.trim().length < 3 ? t('admin.access.typeAtLeast3')
            : searching ? t('admin.access.searching')
            : match ? t('admin.access.found', { name: match.name })
            : t('admin.access.noMatch')}
          {match && <EveWhoLink kind={kind} id={match.id} t={t} />}
        </span>
        <button type="button" className="btn btn--ghost btn--sm" disabled={!match || submitting} onClick={addGrant}>
          {submitting ? t('admin.access.adding') : t('admin.access.add')}
        </button>
      </div>
      {addError && <div className={styles.pgError}>{addError}</div>}

      {loading ? <div className={styles.pgLoading}>{t('admin.access.loading')}</div>
        : error ? <div className={styles.pgError}>{error}</div>
        : grants.length === 0 ? <div className={styles.pgEmpty}>{t('admin.access.none')}</div>
        : (
          <table className={styles.mTable}>
            <thead>
              <tr>
                <th>{t('admin.access.colKind')}</th>
                <th>{t('admin.access.colEntity')}</th>
                <th>{t('admin.access.colSource')}</th>
                <th>{t('admin.access.colAddedBy')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id}>
                  <td>{t(`admin.access.kind_${g.kind}`)}</td>
                  <td title={String(g.eveId)}>
                    {g.label}
                    <EveWhoLink kind={g.kind} id={g.eveId} t={t} />
                  </td>
                  <td>{g.source === 'env' ? t('admin.access.sourceEnv') : g.source}</td>
                  <td>{g.addedByName ?? (g.source === 'env' ? t('admin.access.sourceEnv') : DASH)}</td>
                  <td>
                    {g.immutable
                      ? <span className={styles.mPill} title={t('admin.access.envLockedHint')}>{t('admin.access.envLocked')}</span>
                      : <button type="button" className={`btn btn--ghost btn--sm ${styles.mDanger}`} onClick={() => removeGrant(g)}>
                          {t('admin.access.remove')}
                        </button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </div>
  );
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
  lastKnownSystemId:   number | null;
  lastKnownSystemName: string | null;
  lastKnownSystemAt:   string | null;
}

type UserSortKey = 'characterName' | 'corpTicker' | 'allianceTicker' | 'role' | 'blocked' | 'lastLogin' | 'lastKnownSystemName';
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
      className={[styles.mThSort, active && styles.mThSortActive].filter(Boolean).join(' ')}
      onClick={() => onToggle(col)}
      role="button"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label} <span className={styles.mThSortArrow}>{arrow}</span>
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
  const { t } = useTranslation();
  const { user: self } = useAuth();
  const canEdit = !!self && isAdminRole(self.role);
  // Only an alliance admin may hand out (or modify) the alliance_admin tier.
  const canGrantAllianceAdmin = !!self && isAllianceAdminRole(self.role);
  const [users, setUsers]     = useState<AdminUser[] | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [busyId, setBusyId]   = useState<number | null>(null);
  const [blockTarget, setBlockTarget] = useState<AdminUser | null>(null);
  const [showRoles, setShowRoles] = useState(false);
  const [query, setQuery] = useState('');
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

  // Case-insensitive substring filter over character name plus corp/alliance
  // ticker + name, so an admin can jump to a member by any of those.
  const visibleUsers = useMemo(() => {
    const base = sortedUsers ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return base;
    return base.filter((u) => [
      u.characterName, u.corpTicker, u.corpName, u.allianceTicker, u.allianceName,
    ].some((v) => v?.toLowerCase().includes(q)));
  }, [sortedUsers, query]);

  const load = useCallback(async () => {
    try {
      const r = await api<{ users: AdminUser[] }>('/api/admin/users');
      setUsers(r.users);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.users.loadFailed'));
    }
  }, [t]);

  // load() is async and only setStates after its await (never synchronously),
  // so this fetch-on-mount of a reusable loader is safe; the rule is a false
  // positive here.
  // eslint-disable-next-line react-hooks/set-state-in-effect
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
      setError(e instanceof Error ? e.message : t('admin.users.roleChangeFailed'));
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
      setError(e instanceof Error ? e.message : t('admin.users.blockChangeFailed'));
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
      setError(e instanceof Error ? e.message : t('admin.users.recheckFailed'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className={styles.pgSectionHead}>
        <h2 className={styles.pgSectionTitle}>{t('admin.users.title')}</h2>
        <input
          type="search"
          className={styles.usersSearch}
          placeholder={t('admin.users.searchPlaceholder')}
          aria-label={t('admin.users.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowRoles(true)}>
          {t('admin.roles.button')}
        </button>
      </div>
      {showRoles && <RolesInfoModal onClose={() => setShowRoles(false)} />}
      {error && <div className={styles.pgError}>{error}</div>}
      {!users && !error && <div className={styles.pgLoading}>{t('admin.loading')}</div>}
      {users && !users.length && <div className={styles.pgEmpty}>{t('admin.users.none')}</div>}
      {users && users.length > 0 && (
        <table className={styles.mTable}>
          <thead>
            <tr>
              <SortableTh col="characterName"  label={t('admin.users.colCharacter')} sort={sort} onToggle={toggleSort} />
              <SortableTh col="corpTicker"     label={t('admin.users.colCorp')}      sort={sort} onToggle={toggleSort} />
              <SortableTh col="allianceTicker" label={t('admin.users.colAlliance')}  sort={sort} onToggle={toggleSort} />
              <SortableTh col="role"           label={t('admin.users.colRole')}      sort={sort} onToggle={toggleSort} />
              <SortableTh col="blocked"        label={t('admin.users.colStatus')}    sort={sort} onToggle={toggleSort} />
              <SortableTh col="lastLogin"      label={t('admin.users.colLastLogin')} sort={sort} onToggle={toggleSort} />
              <SortableTh col="lastKnownSystemName" label={t('admin.users.colLastKnown')} sort={sort} onToggle={toggleSort} />
              {canEdit && <th aria-label={t('actions.column')} />}
            </tr>
          </thead>
          <tbody>
            {visibleUsers.map((u) => {
              const isSelf = self?.id === u.id;
              const isBusy = busyId === u.id;
              return (
                <tr key={u.id} className={u.blocked ? styles.mTrBlocked : ''}>
                  <td className={styles.mNameCell}>
                    <img
                      className={styles.mAvatar}
                      src={charPortrait(u.characterId, 32)}
                      alt=""
                    />
                    <span>{u.characterName}</span>
                    {isSelf && <span className={styles.mSelfTag}>{t('admin.users.you')}</span>}
                  </td>
                  <td title={u.corpName ?? undefined}>
                    {u.corpTicker
                      ? <span className={styles.mTicker}>[{u.corpTicker}]</span>
                      : <span className={styles.mMono}>{u.corpId ?? '—'}</span>}
                  </td>
                  <td title={u.allianceName ?? undefined}>
                    {u.allianceTicker
                      ? <span className={styles.mTicker}>[{u.allianceTicker}]</span>
                      : <span className={styles.mMono}>—</span>}
                  </td>
                  <td>
                    {canEdit ? (
                      <select
                        className={styles.mRoleSelect}
                        value={u.role}
                        // A non-alliance-admin can't touch an alliance admin's
                        // role, nor grant the tier (matches the server guard).
                        disabled={isBusy || isSelf || (u.role === 'alliance_admin' && !canGrantAllianceAdmin)}
                        onChange={(e) => changeRole(u, e.target.value as Role)}
                      >
                        {ROLES
                          .filter((r) => r !== 'alliance_admin' || canGrantAllianceAdmin)
                          .map((r) => <option key={r} value={r}>{formatRole(r)}</option>)}
                      </select>
                    ) : (
                      <span className={styles.mMono}>{formatRole(u.role as AuthRole)}</span>
                    )}
                  </td>
                  <td>
                    {u.blocked
                      ? <span className={`${styles.mPill} ${styles.mPillBlocked}`}>{t('admin.users.blocked')}</span>
                      : <span className={`${styles.mPill} ${styles.mPillOk}`}>{t('admin.users.active')}</span>}
                  </td>
                  <td className={styles.mWhen}>{formatRelative(t, u.lastLogin)}</td>
                  <td title={u.lastKnownSystemAt ? formatRelative(t, u.lastKnownSystemAt) : undefined}>
                    {u.lastKnownSystemName ?? '—'}
                  </td>
                  {canEdit && (
                    <td className={styles.mActions}>
                      {u.blocked ? (
                        <button className="btn btn--ghost btn--sm" disabled={isBusy} onClick={() => setBlocked(u, false)}>
                          {t('admin.users.unblock')}
                        </button>
                      ) : (
                        <button
                          className={`btn btn--ghost btn--sm ${styles.mDanger}`}
                          disabled={isBusy || isSelf}
                          onClick={() => setBlockTarget(u)}
                        >
                          {t('admin.users.block')}
                        </button>
                      )}
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={isBusy}
                        onClick={() => recheckCorp(u)}
                        title={t('admin.users.recheckTitle')}
                      >
                        {t('admin.users.recheck')}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {users && users.length > 0 && query.trim() && visibleUsers.length === 0 && (
        <div className={styles.pgEmpty}>{t('admin.users.noMatch', { query: query.trim() })}</div>
      )}

      {blockTarget && (
        <ConfirmModal
          message={t('admin.users.blockConfirm', { name: blockTarget.characterName })}
          confirmLabel={t('admin.users.block')}
          danger
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
  const { t } = useTranslation();
  const [maps, setMaps]   = useState<AdminMap[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AdminMap | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ maps: AdminMap[] }>('/api/admin/maps');
      setMaps(r.maps);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.maps.loadFailed'));
    }
  }, [t]);

  // load() is async and only setStates after its await (never synchronously),
  // so this fetch-on-mount of a reusable loader is safe; the rule is a false
  // positive here.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function setLock(m: AdminMap, locked: boolean) {
    setBusyId(m.id);
    try {
      await api(`/api/admin/maps/${m.id}/${locked ? 'lock' : 'unlock'}`, { method: 'POST' });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.maps.lockChangeFailed'));
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
      setError(e instanceof Error ? e.message : t('admin.maps.deleteFailed'));
    } finally {
      setBusyId(null);
      setDeleteTarget(null);
    }
  }

  return (
    <>
      <h2 className={styles.pgSectionTitle}>{t('admin.maps.title')}</h2>
      {error && <div className={styles.pgError}>{error}</div>}
      {!maps && !error && <div className={styles.pgLoading}>{t('admin.loading')}</div>}
      {maps && !maps.length && <div className={styles.pgEmpty}>{t('admin.maps.none')}</div>}
      {maps && maps.length > 0 && (
        <table className={styles.mTable}>
          <thead>
            <tr>
              <th>{t('admin.maps.colName')}</th>
              <th>{t('admin.maps.colOwner')}</th>
              <th>{t('admin.maps.colCorp')}</th>
              <th>{t('admin.maps.colSystems')}</th>
              <th>{t('admin.maps.colConnections')}</th>
              <th>{t('admin.maps.colLock')}</th>
              <th>{t('admin.maps.colLastActive')}</th>
              <th aria-label={t('actions.column')} />
            </tr>
          </thead>
          <tbody>
            {maps.map((m) => {
              const isBusy = busyId === m.id;
              return (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td className={styles.mNameCell}>
                    <img
                      className={styles.mAvatar}
                      src={charPortrait(m.ownerCharacterId, 32)}
                      alt=""
                    />
                    <span>{m.ownerCharacterName}</span>
                  </td>
                  <td title={m.corpName ?? undefined}>
                    {m.corpTicker
                      ? <span className={styles.mTicker}>[{m.corpTicker}]</span>
                      : <span className={styles.mMono}>{m.corpId}</span>}
                  </td>
                  <td className={styles.mNum}>{m.systemCount}</td>
                  <td className={styles.mNum}>{m.connectionCount}</td>
                  <td>
                    {m.locked
                      ? <span className={`${styles.mPill} ${styles.mPillBlocked}`}>{t('admin.maps.locked')}</span>
                      : <span className={`${styles.mPill} ${styles.mPillOk}`}>{t('admin.maps.open')}</span>}
                  </td>
                  <td className={styles.mWhen}>{formatRelative(t, m.lastActiveAt)}</td>
                  <td className={styles.mActions}>
                    {m.locked ? (
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={isBusy}
                        onClick={() => setLock(m, false)}
                        title={t('admin.maps.unlockTitle')}
                      >
                        {t('admin.maps.unlock')}
                      </button>
                    ) : (
                      <button
                        className="btn btn--ghost btn--sm"
                        disabled={isBusy}
                        onClick={() => setLock(m, true)}
                        title={t('admin.maps.lockTitle')}
                      >
                        {t('admin.maps.lock')}
                      </button>
                    )}
                    <button
                      className={`btn btn--ghost btn--sm ${styles.mDanger}`}
                      disabled={isBusy}
                      onClick={() => setDeleteTarget(m)}
                    >
                      {t('actions.delete')}
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
          message={t('admin.maps.deleteConfirm', { name: deleteTarget.name, owner: deleteTarget.ownerCharacterName })}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => destroy(deleteTarget)}
        />
      )}
    </>
  );
}

// ── Reports tab ─────────────────────────────────────────────────────────────

type ReportKind = 'users' | 'systems' | 'ghost-sites';

const REPORTS: { key: ReportKind }[] = [
  { key: 'users'       },
  { key: 'systems'     },
  { key: 'ghost-sites' },
];

// 'ghost-sites' doesn't map cleanly onto a dotted i18n key, so spell the
// sub-tab labels out rather than building keys dynamically.
const REPORT_TAB_KEY: Record<ReportKind, 'admin.reports.tabs.users' | 'admin.reports.tabs.systems' | 'admin.reports.tabs.ghostSites'> = {
  users:         'admin.reports.tabs.users',
  systems:       'admin.reports.tabs.systems',
  'ghost-sites': 'admin.reports.tabs.ghostSites',
};

type WindowKey = 'all' | '24h' | 'week' | 'month' | 'year';
const WINDOW_OPTIONS: { value: WindowKey }[] = [
  { value: 'all'   },
  { value: '24h'   },
  { value: 'week'  },
  { value: 'month' },
  { value: 'year'  },
];

// Match the server's bucket choice: 24h → hourly, week/month → daily,
// year/all → monthly. The chart title narrates whichever bucket is in play
// so admins aren't reading "per day" against monthly points.
function chartTitleFor(t: TFunction, window: WindowKey): string {
  switch (window) {
    case '24h':   return t('admin.reports.systems.chart.hour24');
    case 'week':  return t('admin.reports.systems.chart.dayWeek');
    case 'month': return t('admin.reports.systems.chart.dayMonth');
    case 'year':  return t('admin.reports.systems.chart.monthYear');
    case 'all':   return t('admin.reports.systems.chart.monthAll');
  }
}

type UserFilterKey = 'all' | 'logins' | 'signatures' | 'structures';
const USER_FILTER_OPTIONS: { value: UserFilterKey }[] = [
  { value: 'all'        },
  { value: 'logins'     },
  { value: 'signatures' },
  { value: 'structures' },
];

function ReportsTab() {
  const { t } = useTranslation();
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
      <h2 className={styles.pgSectionTitle}>{t('admin.reports.title')}</h2>
      <div className={styles.pgSubtabs}>
        {visibleReports.map((r) => (
          <button
            key={r.key}
            className={[styles.pgSubtab, kind === r.key && styles.pgSubtabActive].filter(Boolean).join(' ')}
            onClick={() => navigate(`/admin/reports/${r.key}`)}
          >
            {t(REPORT_TAB_KEY[r.key])}
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
  lastKnownSystemId:    number | null;
  lastKnownSystemName:  string | null;
  lastCorpSigAt:        string | null;
  lastActive:           string | null;
  systemsAdded:         number;
  systemsDeleted:       number;
  sigTypeCounts:        Record<string, number>;
}

type SigTypeKey = 'data' | 'relic' | 'wormhole' | 'gas' | 'ore' | 'combat' | 'unknown';
const SIG_TYPE_ORDER: { key: SigTypeKey; label: string }[] = [
  { key: 'data',     label: 'Data'     },
  { key: 'relic',    label: 'Relic'    },
  { key: 'wormhole', label: 'WH'       },
  { key: 'gas',      label: 'Gas'      },
  { key: 'ore',      label: 'Ore'      },
  { key: 'combat',   label: 'Combat'   },
  { key: 'unknown',  label: 'Unknown'  },
];

type UserReportFixedKey =
  | 'name' | 'corp' | 'alliance' | 'lastLogin' | 'lastKnown' | 'lastActive' | 'lastCorpSig'
  | 'sigTotal' | 'systemsAdded' | 'systemsDeleted';
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
  lastKnown:      (r) => r.lastKnownSystemName?.toLowerCase() ?? null,
  lastActive:     (r) => r.lastActive      ? new Date(r.lastActive).getTime()      : null,
  lastCorpSig:    (r) => r.lastCorpSigAt    ? new Date(r.lastCorpSigAt).getTime()    : null,
  sigTotal:       (r) => Object.values(r.sigTypeCounts).reduce((a, b) => a + b, 0),
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
  const { t } = useTranslation();
  const [rows, setRows]   = useState<UserReportRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort]   = useState<{ key: UserReportSortKey; dir: SortDir }>({ key: 'name', dir: 'asc' });
  const [filter, setFilter] = useState<UserFilterKey>('all');
  const [window, setWindow] = useState<WindowKey>('all');

  // Reset to the loading state during render when the query changes, so the
  // fetch effect below performs no synchronous setState.
  const reqKey = `${filter}|${window}`;
  const [prevKey, setPrevKey] = useState(reqKey);
  if (prevKey !== reqKey) {
    setPrevKey(reqKey);
    setRows(null);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (filter !== 'all') params.set('filter', filter);
    if (window !== 'all') params.set('window', window);
    const qs = params.toString();
    api<{ users: UserReportRow[] }>(`/api/admin/reports/users${qs ? `?${qs}` : ''}`)
      .then((r) => { if (!cancelled) setRows(r.users); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('admin.reports.users.loadFailed')); });
    return () => { cancelled = true; };
  }, [filter, window, t]);

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
      'Last login (ISO)', 'Last known system',
      'Systems added', 'Systems deleted',
      'Last active (ISO)',
      'Last corp signature (ISO)', 'Total signatures',
      ...SIG_TYPE_ORDER.map((st) => st.label),
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
        u.lastKnownSystemName ?? '',
        String(u.systemsAdded),
        String(u.systemsDeleted),
        u.lastActive       ?? '',
        u.lastCorpSigAt    ?? '',
        String(total),
        ...SIG_TYPE_ORDER.map((st) => String(u.sigTypeCounts[st.key] ?? 0)),
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
    <div className={styles.pgFilterBar}>
      <div className={styles.pgFilterGroup}>
        <label className={styles.pgFilterLabel}>{t('admin.reports.filter')}</label>
        <select
          className={styles.mRoleSelect}
          value={filter}
          onChange={(e) => setFilter(e.target.value as UserFilterKey)}
        >
          {USER_FILTER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(`admin.reports.userFilters.${o.value}`)}</option>)}
        </select>
      </div>
      <div className={styles.pgFilterGroup}>
        <label className={styles.pgFilterLabel}>{t('admin.reports.window')}</label>
        <select
          className={styles.mRoleSelect}
          value={window}
          onChange={(e) => setWindow(e.target.value as WindowKey)}
          disabled={filter === 'all'}
          title={filter === 'all' ? t('admin.reports.windowHint') : ''}
        >
          {WINDOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(`admin.reports.windowOptions.${o.value}`)}</option>)}
        </select>
      </div>
      <div className={styles.pgFilterSpacer} />
      {sortedRows && sortedRows.length > 0 && (
        <button className="btn btn--ghost btn--sm" onClick={downloadCsv}>
          ↓ {t('admin.exportCsv')}
        </button>
      )}
    </div>
  );

  if (error) return <>{controls}<div className={styles.pgError}>{error}</div></>;
  if (!sortedRows) return <>{controls}<div className={styles.pgLoading}>{t('admin.loading')}</div></>;
  if (!sortedRows.length) return <>{controls}<div className={styles.pgEmpty}>{t('admin.reports.users.empty')}</div></>;

  return (
    <>
    {controls}
    <div className="admin-page__stat-grid">
      <StatCard label={t('admin.reports.users.totalUsers')}      value={summary.users}     accent />
      <StatCard label={t('admin.reports.users.uniqueCorps')}     value={summary.corps} />
      <StatCard label={t('admin.reports.users.uniqueAlliances')} value={summary.alliances} />
    </div>
    <table className={`${styles.mTable} admin-page__sortable`}>
      <thead>
        <tr>
          <SortHeader label={t('admin.reports.users.colCharacter')}         colKey="name"           sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colCorp')}              colKey="corp"           sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colAlliance')}          colKey="alliance"       sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colLastLogin')}         colKey="lastLogin"      sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colLastKnown')}         colKey="lastKnown"      sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colSystemsAdded')}      colKey="systemsAdded"   sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colSystemsDeleted')}    colKey="systemsDeleted" sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colLastActive')}        colKey="lastActive"     sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colLastCorpSignature')} colKey="lastCorpSig"    sort={sort} onSort={handleSort} />
          <SortHeader label={t('admin.reports.users.colTotalSignatures')}   colKey="sigTotal"       sort={sort} onSort={handleSort} />
          {SIG_TYPE_ORDER.map((st) => (
            <SortHeader
              key={st.key}
              label={t(`admin.reports.sig.${st.key}`)}
              colKey={`sig:${st.key}` as UserReportSortKey}
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
              <td className={styles.mNameCell}>
                <img
                  className={styles.mAvatar}
                  src={charPortrait(u.characterId, 32)}
                  alt=""
                />
                <span>{u.characterName}</span>
              </td>
              <td title={u.corpName ?? undefined}>
                {u.corpTicker
                  ? <span className={styles.mTicker}>[{u.corpTicker}]</span>
                  : <span className={styles.mMono}>{u.corpId ?? '—'}</span>}
              </td>
              <td title={u.allianceName ?? undefined}>
                {u.allianceTicker
                  ? <span className={styles.mTicker}>[{u.allianceTicker}]</span>
                  : u.allianceId !== null
                    ? <span className={styles.mMono}>{u.allianceId}</span>
                    : '—'}
              </td>
              <td className={styles.mWhen}>{u.lastLogin ? formatRelative(t, u.lastLogin) : '—'}</td>
              <td>{u.lastKnownSystemName ?? '—'}</td>
              <td className={styles.mNum}>{u.systemsAdded   > 0 ? u.systemsAdded   : '—'}</td>
              <td className={styles.mNum}>{u.systemsDeleted > 0 ? u.systemsDeleted : '—'}</td>
              <td className={styles.mWhen}>{u.lastActive ? formatRelative(t, u.lastActive) : '—'}</td>
              <td className={styles.mWhen}>{u.lastCorpSigAt ? formatRelative(t, u.lastCorpSigAt) : '—'}</td>
              <td className={styles.mNum}>{total > 0 ? total : '—'}</td>
              {SIG_TYPE_ORDER.map((st) => {
                const n = u.sigTypeCounts[st.key] ?? 0;
                return (
                  <td key={st.key} className={styles.mNumCenter}>
                    {n > 0 ? n : <span className={styles.mMono}>—</span>}
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
  const cls = [
    'admin-page__sort-th',
    active && 'admin-page__sort-th--active',
    align === 'center' && styles.pgSortThCenter,
  ].filter(Boolean).join(' ');
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
// CSS custom properties (--cv-sig-* in styles/tokens.css) for colour-vision support.
// Resolved to hex via cssVarToHex where consumed, since the donut paints to a
// <canvas> (chart.js) which can't read var().
const SIG_TYPE_COLORS: Record<string, string> = {
  data:     'var(--cv-sig-data)',
  relic:    'var(--cv-sig-relic)',
  wormhole: 'var(--cv-sig-wormhole)',
  gas:      'var(--cv-sig-gas)',
  ore:      'var(--cv-sig-ore)',
  combat:   'var(--cv-sig-combat)',
  unknown:  'var(--cv-sig-unknown)',
};

type WhSortKey = 'whType' | 'count';

function SystemsReport() {
  const { t } = useTranslation();
  // Subscribed so the canvas donut re-resolves its slice colours (which can't
  // read CSS vars) when the colour-vision mode changes.
  const [colorVision] = useUserSetting<string>('nexum.a11y.colorVision', 'off');
  const [data, setData]   = useState<SystemsReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [whSort, setWhSort] = useState<{ key: WhSortKey; dir: SortDir }>({ key: 'count', dir: 'desc' });
  const [window, setWindow] = useState<WindowKey>('month');

  // Reset to the loading state during render when the window changes, so the
  // fetch effect below performs no synchronous setState.
  const [prevWindow, setPrevWindow] = useState(window);
  if (prevWindow !== window) {
    setPrevWindow(window);
    setData(null);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;
    const qs = window === 'all' ? '' : `?window=${window}`;
    api<SystemsReportData>(`/api/admin/reports/systems${qs}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('admin.reports.systems.loadFailed')); });
    return () => { cancelled = true; };
  }, [window, t]);

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
    <div className={styles.pgFilterBar}>
      <div className={styles.pgFilterGroup}>
        <label className={styles.pgFilterLabel}>{t('admin.reports.window')}</label>
        <select
          className={styles.mRoleSelect}
          value={window}
          onChange={(e) => setWindow(e.target.value as WindowKey)}
        >
          {WINDOW_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(`admin.reports.windowOptions.${o.value}`)}</option>)}
        </select>
      </div>
    </div>
  );

  if (error) return <>{controls}<div className={styles.pgError}>{error}</div></>;
  if (!data || !sortedWh) return <>{controls}<div className={styles.pgLoading}>{t('admin.loading')}</div></>;
  if (data.total === 0) return <>{controls}<div className={styles.pgEmpty}>{t('admin.reports.systems.empty')}</div></>;

  // Exclude unidentified ("unknown") signatures from the sig-type breakdown —
  // they're not a real type, so they're left out of the stat cards, the donut,
  // and the percentage denominator (percentages are of identified sigs only).
  const knownTypes = SIG_TYPE_ORDER.filter((st) => st.key !== 'unknown');
  const knownTotal = knownTypes.reduce((sum, st) => sum + (data.byType[st.key] ?? 0), 0);

  const donutEntries = knownTypes
    .map((st) => ({ key: st.key, label: t(`admin.reports.sig.${st.key}`), count: data.byType[st.key] ?? 0 }))
    .filter((e) => e.count > 0);

  return (
    <>
      {controls}
      <h3 className="admin-page__report-heading">{t('admin.reports.systems.heading')}</h3>
      <div className="admin-page__stat-grid">
        <StatCard label={t('admin.reports.systems.total')} value={knownTotal} accent />
        {knownTypes.map((st) => {
          const count = data.byType[st.key] ?? 0;
          return (
            <StatCard
              key={st.key}
              label={t(`admin.reports.sig.${st.key}`)}
              value={count}
              pct={knownTotal > 0 ? (count / knownTotal) * 100 : 0}
            />
          );
        })}
      </div>

      <div className="admin-page__chart-row">
        <div className="admin-page__chart-card">
          <div className="admin-page__chart-title">{t('admin.reports.systems.typeMix')}</div>
          <div className="admin-page__chart-canvas">
            <Doughnut
              key={colorVision}
              data={{
                labels:   donutEntries.map((e) => e.label),
                datasets: [{
                  data: donutEntries.map((e) => e.count),
                  backgroundColor: donutEntries.map((e) => cssVarToHex(SIG_TYPE_COLORS[e.key] ?? SIG_TYPE_COLORS.unknown)),
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
          <div className="admin-page__chart-title">{chartTitleFor(t, window)}</div>
          <div className="admin-page__chart-canvas">
            <Line
              data={{
                labels: data.dailyTotals.map((d) => d.day),
                datasets: [{
                  label:           t('admin.reports.systems.sigLabel'),
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

      <h3 className="admin-page__report-heading">{t('admin.reports.systems.whHeading')}</h3>
      {sortedWh.length === 0 ? (
        <div className={styles.pgEmpty}>{t('admin.reports.systems.whEmpty')}</div>
      ) : (
        <table className={`${styles.mTable} admin-page__sortable admin-page__wh-table`}>
          <thead>
            <tr>
              <SortHeader label={t('admin.reports.systems.colType')}  colKey="whType" sort={whSort} onSort={handleWhSort} />
              <SortHeader label={t('admin.reports.systems.colCount')} colKey="count"  sort={whSort} onSort={handleWhSort} />
            </tr>
          </thead>
          <tbody>
            {sortedWh.map((row) => (
              <tr key={row.whType}>
                <td className={styles.mMono}>{row.whType}</td>
                <td className={styles.mNum}>{row.count}</td>
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
  const { t } = useTranslation();
  const [rows, setRows]   = useState<GhostSiteRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort]   = useState<{ key: GhostSortKey; dir: SortDir }>({ key: 'region', dir: 'asc' });

  useEffect(() => {
    api<{ rows: GhostSiteRow[] }>('/api/admin/reports/ghost-sites')
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e instanceof Error ? e.message : t('admin.reports.ghost.loadFailed')));
  }, [t]);

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

  if (error)   return <div className={styles.pgError}>{error}</div>;
  if (!sorted) return <div className={styles.pgLoading}>{t('admin.loading')}</div>;

  return (
    <>
      <h3 className="admin-page__report-heading">{t('admin.reports.ghost.heading')}</h3>
      {sorted.length === 0 ? (
        <div className={styles.pgEmpty}>{t('admin.reports.ghost.empty')}</div>
      ) : (
        <table className={`${styles.mTable} admin-page__sortable`}>
          <thead>
            <tr>
              <SortHeader label={t('admin.reports.ghost.colRegion')}        colKey="region"        sort={sort} onSort={onSort} />
              <SortHeader label={t('admin.reports.ghost.colConstellation')} colKey="constellation" sort={sort} onSort={onSort} />
              <SortHeader label={t('admin.reports.ghost.colSystem')}        colKey="system"        sort={sort} onSort={onSort} />
              <SortHeader label={t('admin.reports.ghost.colClass')}         colKey="class"         sort={sort} onSort={onSort} />
              <SortHeader label={t('admin.reports.ghost.colSun')}           colKey="sunType"       sort={sort} onSort={onSort} />
              <SortHeader label={t('admin.reports.ghost.colPlanets')}       colKey="planets"       sort={sort} onSort={onSort} />
              <SortHeader label={t('admin.reports.ghost.colMoons')}         colKey="moons"         sort={sort} onSort={onSort} />
              <SortHeader label={t('admin.reports.ghost.colObservations')}  colKey="observations"  sort={sort} onSort={onSort} />
              <SortHeader label={t('admin.reports.ghost.colLastSeen')}      colKey="lastSeen"      sort={sort} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.eveSystemId}>
                <td>{r.regionName        ?? '—'}</td>
                <td>{r.constellationName ?? '—'}</td>
                <td className={styles.mMono}>{r.systemName}</td>
                <td>{r.systemClass}</td>
                <td>{r.sunType     ?? '—'}</td>
                <td className={styles.mNum}>{r.planetCount ?? '—'}</td>
                <td className={styles.mNum}>{r.moonCount   ?? '—'}</td>
                <td className={styles.mNum}>{r.observations}</td>
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
  const { t } = useTranslation();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    api<{ entries: AuditEntry[] }>('/api/admin/audit')
      .then((r) => setEntries(r.entries))
      .catch((e) => setError(e instanceof Error ? e.message : t('admin.audit.loadFailed')));
  }, [t]);

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
      <div className={styles.pgSectionBar}>
        <h2 className={styles.pgSectionTitle}>{t('admin.audit.title')}</h2>
        {entries && entries.length > 0 && (
          <button className="btn btn--ghost btn--sm" onClick={downloadCsv}>
            ↓ {t('admin.exportCsv')}
          </button>
        )}
      </div>
      {error && <div className={styles.pgError}>{error}</div>}
      {!entries && !error && <div className={styles.pgLoading}>{t('admin.loading')}</div>}
      {entries && !entries.length && <div className={styles.pgEmpty}>{t('admin.audit.none')}</div>}
      {entries && entries.length > 0 && (
        <table className={styles.mTable}>
          <thead>
            <tr>
              <th>{t('admin.audit.colWhen')}</th>
              <th>{t('admin.audit.colActor')}</th>
              <th>{t('admin.audit.colAction')}</th>
              <th>{t('admin.audit.colTarget')}</th>
              <th>{t('admin.audit.colChange')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td className={styles.mWhen}>{formatRelative(t, e.createdAt)}</td>
                <td>{e.actorCharacterName ?? '—'}</td>
                <td><span className={styles.mAction}>{e.action}</span></td>
                <td>{e.targetCharacterName ?? '—'}</td>
                <td className={styles.mMono}>
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

function formatRelative(t: TFunction, iso: string | null | undefined): string {
  if (!iso) return DASH;
  const date = new Date(iso);
  const then = date.getTime();
  if (Number.isNaN(then)) return DASH;
  // Anything older than ~a month is more useful as an absolute European
  // date (DD-MM-YYYY) than "65d ago".
  if (Date.now() - then >= 86400 * 30 * 1000) return europeanDate(date);
  return timeAgo(t, date);
}

// RFC 4180 CSV escaping: wrap in double quotes if the field contains a
// comma, quote, CR, or LF, doubling any embedded quotes.
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

// ── Discord tab ───────────────────────────────────────────────────────────────
interface DiscordSettings {
  scope:        'corp' | 'alliance' | null;
  allRegions:   boolean;
  regions:      string[];
  notifyChains: boolean;
  whTypes:      string[];
  whClasses:    string[];
  whSizes:      string[];
  connectionsWebhook: string;
  chainsWebhook:      string;
  maps:         { id: string; name: string; excluded: boolean }[];
}
interface RegionOption { id: number; name: string }

// Fixed vocab for the wormhole filters (mirrors the server). Empty = all.
// Class chips show the raw EVE class code (no translation needed); size chips
// reuse the existing connection-panel size labels.
const WH_CLASS_OPTS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C13', 'HS', 'LS', 'NS', 'Thera', 'Pochven', 'Drifter', 'Turnur'];
const WH_SIZE_OPTS = [
  { key: 'small',  labelKey: 'connPanel.sizeSmall'  },
  { key: 'medium', labelKey: 'connPanel.sizeMedium' },
  { key: 'large',  labelKey: 'connPanel.sizeLarge'  },
  { key: 'xl',     labelKey: 'connPanel.sizeXl'     },
] as const;

function DiscordTab() {
  const { t } = useTranslation();
  const whCatalog = useWormholeTypes();
  const [data, setData]           = useState<DiscordSettings | null>(null);
  const [regionOpts, setRegionOpts] = useState<RegionOption[]>([]);
  const [error, setError]         = useState<string | null>(null);
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);

  // Editable copy of the region filter.
  const [allRegions, setAllRegions] = useState(true);
  const [regions, setRegions]       = useState<string[]>([]);
  const [query, setQuery]           = useState('');
  // Editable copies of the wormhole filters (empty list = all).
  const [whTypes, setWhTypes]     = useState<string[]>([]);
  const [whClasses, setWhClasses] = useState<string[]>([]);
  const [whSizes, setWhSizes]     = useState<string[]>([]);
  const [whQuery, setWhQuery]     = useState('');
  // Editable copies of the per-event webhook URLs (empty = off).
  const [connWebhook, setConnWebhook]   = useState('');
  const [chainWebhook, setChainWebhook] = useState('');

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        api<DiscordSettings>('/api/admin/discord'),
        api<{ regions: RegionOption[] }>('/api/regions'),
      ]);
      setData(s);
      setAllRegions(s.allRegions);
      setRegions(s.regions);
      setWhTypes(s.whTypes ?? []);
      setWhClasses(s.whClasses ?? []);
      setWhSizes(s.whSizes ?? []);
      setConnWebhook(s.connectionsWebhook ?? '');
      setChainWebhook(s.chainsWebhook ?? '');
      setRegionOpts(r.regions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.discord.loadFailed'));
    }
  }, [t]);
  // load() is async and only setStates after its await (never synchronously),
  // so this fetch-on-mount of a reusable loader is safe; the rule is a false
  // positive here.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, [load]);

  async function saveFilters() {
    if (!data) return;
    setSaving(true); setSaved(false);
    try {
      // Send every field the PUT can wipe (it defaults absent flags/lists), so a
      // save never silently resets the chain toggle or another filter dimension.
      await api('/api/admin/discord', { method: 'PUT', body: JSON.stringify({ allRegions, regions, notifyChains: data.notifyChains, whTypes, whClasses, whSizes, connectionsWebhook: connWebhook.trim(), chainsWebhook: chainWebhook.trim() }) });
      setData((d) => (d ? { ...d, allRegions, regions, whTypes, whClasses, whSizes, connectionsWebhook: connWebhook.trim(), chainsWebhook: chainWebhook.trim() } : d));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.discord.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  // Broadcast toggles persist immediately, using the last-saved filters so an
  // unsaved draft isn't dragged along and no other filter is wiped.
  async function toggleChains(next: boolean) {
    if (!data) return;
    const prev = data.notifyChains;
    setData((d) => (d ? { ...d, notifyChains: next } : d));
    try {
      await api('/api/admin/discord', { method: 'PUT', body: JSON.stringify({ allRegions: data.allRegions, regions: data.regions, notifyChains: next, whTypes: data.whTypes, whClasses: data.whClasses, whSizes: data.whSizes, connectionsWebhook: data.connectionsWebhook, chainsWebhook: data.chainsWebhook }) });
    } catch (e) {
      setData((d) => (d ? { ...d, notifyChains: prev } : d));
      setError(e instanceof Error ? e.message : t('admin.discord.saveFailed'));
    }
  }

  const toggleIn = (list: string[], set: (v: string[]) => void, val: string) =>
    set(list.includes(val) ? list.filter((x) => x !== val) : [...list, val]);

  async function toggleMap(id: string, excluded: boolean) {
    setData((d) => (d ? { ...d, maps: d.maps.map((m) => (m.id === id ? { ...m, excluded } : m)) } : d));
    try {
      await api(`/api/admin/maps/${id}/discord`, { method: 'PATCH', body: JSON.stringify({ excluded }) });
    } catch (e) {
      setError(e instanceof Error ? e.message : t('admin.discord.updateFailed'));
      load(); // reload to revert the optimistic toggle
    }
  }

  const addRegion    = (name: string) => { if (!regions.includes(name)) setRegions([...regions, name]); setQuery(''); };
  const removeRegion = (name: string) => setRegions(regions.filter((r) => r !== name));

  const q = query.trim().toLowerCase();
  const matches = q
    ? regionOpts.filter((o) => o.name.toLowerCase().includes(q) && !regions.includes(o.name)).slice(0, 8)
    : [];

  const wq = whQuery.trim().toUpperCase();
  const whMatches = wq
    ? Object.keys(whCatalog).filter((c) => c.includes(wq) && !whTypes.includes(c)).sort().slice(0, 8)
    : [];

  if (!data && error) return (<><h2 className={styles.pgSectionTitle}>{t('admin.discord.title')}</h2><div className={styles.pgError}>{error}</div></>);
  if (!data)          return (<><h2 className={styles.pgSectionTitle}>{t('admin.discord.title')}</h2><div className={styles.pgLoading}>{t('admin.loading')}</div></>);
  if (data.scope == null) {
    return (<><h2 className={styles.pgSectionTitle}>{t('admin.discord.title')}</h2>
      <div className={styles.pgEmpty}>{t('admin.discord.noCorp')}</div></>);
  }

  const sortJoin = (a: string[]) => a.slice().sort().join('|');
  const dirty = allRegions !== data.allRegions
    || sortJoin(regions)   !== sortJoin(data.regions)
    || sortJoin(whTypes)   !== sortJoin(data.whTypes)
    || sortJoin(whClasses) !== sortJoin(data.whClasses)
    || sortJoin(whSizes)   !== sortJoin(data.whSizes)
    || connWebhook.trim()  !== data.connectionsWebhook
    || chainWebhook.trim() !== data.chainsWebhook;

  return (
    <>
      <h2 className={styles.pgSectionTitle}>{t('admin.discord.titleNotifications')}</h2>
      {error && <div className={styles.pgError}>{error}</div>}
      <p className={styles.dcHint}>{t('admin.discord.hint')}</p>

      <section className={styles.dcSection}>
        <h3 className={styles.dcHeading}>{t('admin.discord.webhooks')}</h3>
        <p className={styles.dcHint}>{t('admin.discord.webhooksHint')}</p>
        <label className={styles.dcSublabel} htmlFor="conn-webhook">{t('admin.discord.connectionsWebhook')}</label>
        <input
          id="conn-webhook"
          type="url"
          className={`${styles.dcSearch} ${styles.dcSearchWide}`}
          placeholder="https://discord.com/api/webhooks/…"
          value={connWebhook}
          spellCheck={false}
          onChange={(e) => setConnWebhook(e.target.value)}
        />
        <label className={styles.dcSublabel} htmlFor="chain-webhook">{t('admin.discord.chainsWebhook')}</label>
        <input
          id="chain-webhook"
          type="url"
          className={`${styles.dcSearch} ${styles.dcSearchWide}`}
          placeholder="https://discord.com/api/webhooks/…"
          value={chainWebhook}
          spellCheck={false}
          onChange={(e) => setChainWebhook(e.target.value)}
        />
      </section>

      <section className={styles.dcSection}>
        <h3 className={styles.dcHeading}>{t('admin.discord.regions')}</h3>
        <label className={styles.dcRadio}>
          <input type="radio" name="discord-regions" checked={allRegions} onChange={() => setAllRegions(true)} />
          {t('admin.discord.notifyAll')}
        </label>
        <label className={styles.dcRadio}>
          <input type="radio" name="discord-regions" checked={!allRegions} onChange={() => setAllRegions(false)} />
          {t('admin.discord.notifySelected')}
        </label>

        {!allRegions && (
          <div className={styles.dcRegions}>
            <div className={styles.dcChips}>
              {regions.length === 0
                ? <span className={styles.pgEmpty}>{t('admin.discord.noRegionsSelected')}</span>
                : regions.map((r) => (
                    <span key={r} className={styles.dcChip}>
                      {r}
                      <button type="button" onClick={() => removeRegion(r)} aria-label={t('admin.discord.removeRegion', { name: r })}>×</button>
                    </span>
                  ))}
            </div>
            <input
              type="text"
              className={styles.dcSearch}
              placeholder={t('admin.discord.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {matches.length > 0 && (
              <ul className={styles.dcResults}>
                {matches.map((o) => (
                  <li key={o.id}><button type="button" onClick={() => addRegion(o.name)}>{o.name}</button></li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* ── Wormhole filters (type code / dest class / size) — empty = all ── */}
        <h4 className={styles.dcSubheading}>{t('admin.discord.whFilters')}</h4>
        <p className={styles.dcHint}>{t('admin.discord.whFiltersHint')}</p>

        <label className={styles.dcSublabel}>{t('admin.discord.whTypeLabel')}</label>
        <div className={styles.dcChips}>
          {whTypes.length === 0
            ? <span className={styles.pgEmpty}>{t('admin.discord.whAll')}</span>
            : whTypes.map((c) => (
                <span key={c} className={styles.dcChip}>{c}
                  <button type="button" onClick={() => setWhTypes(whTypes.filter((x) => x !== c))} aria-label={t('admin.discord.removeType', { name: c })}>×</button>
                </span>
              ))}
        </div>
        <input
          type="text"
          className={styles.dcSearch}
          placeholder={t('admin.discord.whTypePlaceholder')}
          value={whQuery}
          onChange={(e) => setWhQuery(e.target.value.toUpperCase())}
        />
        {whMatches.length > 0 && (
          <ul className={styles.dcResults}>
            {whMatches.map((c) => (
              <li key={c}>
                <button type="button" onClick={() => { setWhTypes([...whTypes, c]); setWhQuery(''); }}>
                  {c}<span className={styles.dcResultMeta}> → {whCatalog[c]?.dest ?? '?'}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <label className={styles.dcSublabel}>{t('admin.discord.whClassLabel')}</label>
        <div className={styles.dcTogglechips}>
          {WH_CLASS_OPTS.map((c) => (
            <button
              key={c}
              type="button"
              className={[styles.dcTogglechip, whClasses.includes(c) && styles.dcTogglechipOn].filter(Boolean).join(' ')}
              onClick={() => toggleIn(whClasses, setWhClasses, c)}
            >{c}</button>
          ))}
        </div>

        <label className={styles.dcSublabel}>{t('admin.discord.whSizeLabel')}</label>
        <div className={styles.dcTogglechips}>
          {WH_SIZE_OPTS.map((o) => (
            <button
              key={o.key}
              type="button"
              className={[styles.dcTogglechip, whSizes.includes(o.key) && styles.dcTogglechipOn].filter(Boolean).join(' ')}
              onClick={() => toggleIn(whSizes, setWhSizes, o.key)}
            >{t(o.labelKey)}</button>
          ))}
        </div>

        <div className={styles.dcActions}>
          <button className="btn btn--primary" disabled={!dirty || saving} onClick={saveFilters}>
            {saving ? t('admin.discord.saving') : t('actions.save')}
          </button>
          {saved && <span className={styles.dcSaved}>{t('admin.discord.saved')}</span>}
        </div>
      </section>

      <section className={styles.dcSection}>
        <h3 className={styles.dcHeading}>{t('admin.discord.events')}</h3>
        <label className={styles.dcRadio}>
          <input type="checkbox" checked={data.notifyChains} onChange={(e) => toggleChains(e.target.checked)} />
          {t('admin.discord.broadcastChains')}
        </label>
        <p className={styles.dcHint}>{t('admin.discord.broadcastChainsHint')}</p>
      </section>

      <section className={styles.dcSection}>
        <h3 className={styles.dcHeading}>{t('admin.discord.excludedMaps')}</h3>
        <p className={styles.dcHint}>{t('admin.discord.excludedHint')}</p>
        {data.maps.length === 0
          ? <div className={styles.pgEmpty}>{t('admin.discord.noCorpMaps')}</div>
          : (
            <table className={styles.mTable}>
              <thead><tr><th>{t('admin.discord.colMap')}</th><th>{t('admin.discord.colExclude')}</th></tr></thead>
              <tbody>
                {data.maps.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td>
                    <td>
                      <input
                        type="checkbox"
                        className="sig-checkbox"
                        checked={m.excluded}
                        onChange={(e) => toggleMap(m.id, e.target.checked)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>
    </>
  );
}
