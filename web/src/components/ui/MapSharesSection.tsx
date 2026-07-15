import { useEffect, useRef, useState } from 'react';
import { charPortrait, corpLogo, allianceLogo } from '../../utils/eveImages';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { useAuth } from '../../context/AuthContext';
import { toast } from './Toaster';
import { XIcon } from '@phosphor-icons/react';

interface ShareRow {
  id:        string;
  kind:      'character' | 'corp' | 'alliance';
  targetId:  number;
  name:      string | null;
  createdAt: string;
}

type PickerKind = 'character' | 'corp' | 'alliance';
const SEARCH_ENDPOINT: Record<PickerKind, string> = {
  character: '/api/search/characters',
  corp:      '/api/search/corporations',
  alliance:  '/api/search/alliances',
};

interface ResolvedMatch {
  id:   number;
  name: string;
}

const DEBOUNCE_MS = 350;

export function MapSharesSection() {
  const { t } = useTranslation();
  const mapId  = useMapStore((s) => s.activeMapId);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // Picker state
  const { user } = useAuth();
  const allowAlliance = !!user?.allianceMode;
  const KINDS: PickerKind[] = allowAlliance ? ['character', 'corp', 'alliance'] : ['character', 'corp'];
  const [kind, setKind]   = useState<PickerKind>('character');
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState<ResolvedMatch | null>(null);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // On a restricted deployment, sharing to a corp/alliance can also admit their
  // members to log in (they'd otherwise be shared-but-locked-out). Default on.
  const [grantLogin, setGrantLogin] = useState(true);
  const canGrantLogin = !!user?.corpMode || !!user?.allianceMode;

  // Re-load shares whenever the active map changes.
  useEffect(() => {
    if (!mapId) { setShares([]); return; }
    setLoading(true);
    setError(null);
    api<{ shares: ShareRow[] }>(`/api/maps/${mapId}/shares`)
      .then((r) => setShares(r.shares))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mapId]);

  // Debounced ESI name lookup. Re-runs whenever the query or the kind toggle
  // changes. Clears the match while the user is still typing.
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setMatch(null);
    const q = query.trim();
    if (q.length < 3) { setSearching(false); return; }

    setSearching(true);
    searchTimer.current = setTimeout(() => {
      api<{ match: ResolvedMatch | null }>(`${SEARCH_ENDPOINT[kind]}?q=${encodeURIComponent(q)}`)
        .then((r) => setMatch(r.match))
        .catch(() => setMatch(null))
        .finally(() => setSearching(false));
    }, DEBOUNCE_MS);

    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [query, kind]);

  async function addShare() {
    if (!mapId || !match) return;
    const alsoGrantLogin = canGrantLogin && grantLogin;
    setSubmitting(true);
    setError(null);
    try {
      const row = await api<ShareRow & { loginGranted?: boolean }>(`/api/maps/${mapId}/shares`, {
        method: 'POST',
        body:   JSON.stringify({ kind, targetId: match.id, alsoGrantLogin }),
      });
      setShares((prev) => [...prev, row]);
      setQuery('');
      setMatch(null);
      toast.success(row.loginGranted
        ? t('mapShares.sharedWithLogin', { name: row.name ?? match.name })
        : t('mapShares.sharedWith', { name: row.name ?? match.name }));
    } catch (e) {
      const code = e instanceof ApiError ? e.code : undefined;
      const serverMsg = e instanceof ApiError ? e.serverMessage : undefined;
      setError(
        code === 'standing_not_positive'  ? t('mapShares.errStanding') :
        code === 'alliance_not_supported' ? t('mapShares.errAllianceUnsupported') :
        (serverMsg ?? (e instanceof Error ? e.message : t('mapShares.addFailed'))),
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function revokeShare(shareId: string) {
    if (!mapId) return;
    const target = shares.find((s) => s.id === shareId);
    setShares((prev) => prev.filter((s) => s.id !== shareId));
    try {
      await api(`/api/maps/${mapId}/shares/${shareId}`, { method: 'DELETE' });
      toast.info(target?.name ? t('mapShares.accessRevokedFor', { name: target.name }) : t('mapShares.accessRevoked'));
    } catch (e) {
      // Restore the row so the UI doesn't lie about state.
      if (target) setShares((prev) => [...prev, target].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
      setError(e instanceof Error ? e.message : t('mapShares.revokeFailed'));
    }
  }

  const canAdd = !!match && !submitting;

  return (
    <>
      <div className="map-sidebar__hint">
        {t('mapShares.hint')}
      </div>

      <div className="map-shares__picker">
        <div className="map-sidebar__btn-group">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`map-sidebar__btn-group-item${kind === k ? ' map-sidebar__btn-group-item--active' : ''}`}
              onClick={() => { setKind(k); setMatch(null); }}
            >
              {t(`mapShares.${k}`)}
            </button>
          ))}
        </div>

        <input
          className="map-shares__input"
          placeholder={kind === 'character' ? t('mapShares.placeholderChar')
            : kind === 'corp' ? t('mapShares.placeholderCorp')
            : t('mapShares.placeholderAlliance')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={50}
          spellCheck={false}
        />

        <div className="map-shares__match">
          {query.trim().length < 3
            ? <span className="map-shares__match--hint">{t('mapShares.typeAtLeast3')}</span>
            : searching
              ? <span className="map-shares__match--hint">{t('mapShares.searching')}</span>
              : match
                ? <span className="map-shares__match--ok">{t('mapShares.found', { name: match.name })}</span>
                : <span className="map-shares__match--miss">{t('mapShares.noMatch')}</span>}
        </div>

        {canGrantLogin && (
          <label className="map-shares__grant-login">
            <input type="checkbox" checked={grantLogin} onChange={(e) => setGrantLogin(e.target.checked)} />
            {t('mapShares.alsoGrantLogin')}
          </label>
        )}

        <button
          type="button"
          className="map-sidebar__action"
          onClick={addShare}
          disabled={!canAdd}
        >
          {submitting ? t('mapShares.adding') : t('mapShares.share')}
        </button>
      </div>

      <div className="map-shares__list">
        {loading
          ? <div className="map-sidebar__hint">{t('mapShares.loading')}</div>
          : shares.length === 0
            ? <div className="map-sidebar__hint">{t('mapShares.none')}</div>
            : shares.map((s) => (
                <div key={s.id} className="map-shares__row">
                  <img
                    className="map-shares__avatar"
                    src={s.kind === 'character' ? charPortrait(s.targetId, 32)
                      : s.kind === 'corp' ? corpLogo(s.targetId, 32)
                      : allianceLogo(s.targetId, 32)}
                    alt=""
                    loading="lazy"
                  />
                  <span className={`map-shares__kind map-shares__kind--${s.kind}`}>
                    {s.kind === 'character' ? t('mapShares.badgeChar')
                      : s.kind === 'corp' ? t('mapShares.badgeCorp')
                      : t('mapShares.badgeAlliance')}
                  </span>
                  <span className="map-shares__name" title={String(s.targetId)}>
                    {s.name ?? t('mapShares.unknownTarget', { kind: s.kind, id: s.targetId })}
                  </span>
                  <button
                    type="button"
                    className="map-shares__revoke"
                    onClick={() => revokeShare(s.id)}
                    title={t('mapShares.revokeAccess')}
                  >
                    <XIcon size={12} weight="bold" />
                  </button>
                </div>
              ))}
      </div>

      {error && <div className="map-sidebar__hint map-sidebar__hint--error">{error}</div>}
    </>
  );
}
