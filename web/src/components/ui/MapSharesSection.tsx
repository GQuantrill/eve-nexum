import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { toast } from './Toaster';
import { XIcon } from '@phosphor-icons/react';

interface ShareRow {
  id:        string;
  kind:      'character' | 'corp';
  targetId:  number;
  name:      string | null;
  createdAt: string;
}

type PickerKind = 'character' | 'corp';

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
  const [kind, setKind]   = useState<PickerKind>('character');
  const [query, setQuery] = useState('');
  const [match, setMatch] = useState<ResolvedMatch | null>(null);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);

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
      const endpoint = kind === 'character' ? '/api/search/characters' : '/api/search/corporations';
      api<{ match: ResolvedMatch | null }>(`${endpoint}?q=${encodeURIComponent(q)}`)
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
    setSubmitting(true);
    setError(null);
    try {
      const row = await api<ShareRow>(`/api/maps/${mapId}/shares`, {
        method: 'POST',
        body:   JSON.stringify({ kind, targetId: match.id }),
      });
      setShares((prev) => [...prev, row]);
      setQuery('');
      setMatch(null);
      toast.success(t('mapShares.sharedWith', { name: row.name ?? match.name }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('mapShares.addFailed');
      setError(msg);
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
          {(['character', 'corp'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`map-sidebar__btn-group-item${kind === k ? ' map-sidebar__btn-group-item--active' : ''}`}
              onClick={() => { setKind(k); setMatch(null); }}
            >
              {k === 'character' ? t('mapShares.character') : t('mapShares.corp')}
            </button>
          ))}
        </div>

        <input
          className="map-shares__input"
          placeholder={kind === 'character' ? t('mapShares.placeholderChar') : t('mapShares.placeholderCorp')}
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
                    src={s.kind === 'character'
                      ? `https://images.evetech.net/characters/${s.targetId}/portrait?size=32`
                      : `https://images.evetech.net/corporations/${s.targetId}/logo?size=32`}
                    alt=""
                    loading="lazy"
                  />
                  <span className={`map-shares__kind map-shares__kind--${s.kind}`}>
                    {s.kind === 'character' ? t('mapShares.badgeChar') : t('mapShares.badgeCorp')}
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
