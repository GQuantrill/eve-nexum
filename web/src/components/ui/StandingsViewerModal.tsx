import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from '@phosphor-icons/react';
import { api } from '../../api/client';
import { corpLogo, allianceLogo } from '../../utils/eveImages';

interface Contact {
  contactKind: 'corporation' | 'alliance';
  id:          number;
  name:        string;
  ticker:      string | null;
  standing:    number;
}

interface StandingsViewResponse {
  corp:     Contact[] | null;
  alliance: Contact[] | null;
}

type SourceKind = 'corp' | 'alliance';

// The five EVE standing bands, in the order the in-game contact list shows them.
// A tab is selected by its `key`; membership uses the same signed thresholds the
// rest of the app uses for the standings tint (see SystemPanel.standingClass).
type BandLabelKey =
  | 'admin.access.svBand10'
  | 'admin.access.svBand5'
  | 'admin.access.svBand0'
  | 'admin.access.svBandN5'
  | 'admin.access.svBandN10';

const BANDS: Array<{ key: string; labelKey: BandLabelKey; inBand: (s: number) => boolean; cls: string }> = [
  { key: '10',  labelKey: 'admin.access.svBand10',  inBand: (s) => s > 5,             cls: 'standings-viewer__band--excellent' },
  { key: '5',   labelKey: 'admin.access.svBand5',   inBand: (s) => s > 0 && s <= 5,   cls: 'standings-viewer__band--good' },
  { key: '0',   labelKey: 'admin.access.svBand0',   inBand: (s) => s === 0,           cls: 'standings-viewer__band--neutral' },
  { key: '-5',  labelKey: 'admin.access.svBandN5',  inBand: (s) => s < 0 && s >= -5,  cls: 'standings-viewer__band--bad' },
  { key: '-10', labelKey: 'admin.access.svBandN10', inBand: (s) => s < -5,            cls: 'standings-viewer__band--terrible' },
];

interface Props { onClose: () => void; }

export function StandingsViewerModal({ onClose }: Props) {
  const { t } = useTranslation();
  const [data, setData]       = useState<StandingsViewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [source, setSource]   = useState<SourceKind>('corp');
  const [band, setBand]       = useState<string>('10');

  useEffect(() => {
    let alive = true;
    api<StandingsViewResponse>('/api/admin/standings-view')
      .then((r) => {
        if (!alive) return;
        setData(r);
        // Default the source toggle to whichever bucket the deployment actually has.
        setSource(r.corp ? 'corp' : 'alliance');
      })
      .catch((e: Error) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  // Close on Escape, matching the other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hasCorp     = !!data?.corp;
  const hasAlliance = !!data?.alliance;
  const bothSources = hasCorp && hasAlliance;

  const contacts = useMemo<Contact[]>(() => {
    if (!data) return [];
    return (source === 'corp' ? data.corp : data.alliance) ?? [];
  }, [data, source]);

  // Count contacts per band so each tab can show a badge.
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of BANDS) m[b.key] = contacts.filter((c) => b.inBand(c.standing)).length;
    return m;
  }, [contacts]);

  const active = BANDS.find((b) => b.key === band) ?? BANDS[0];
  const rows = useMemo(
    () => contacts.filter((c) => active.inBand(c.standing)).sort((a, b) => a.name.localeCompare(b.name)),
    [contacts, active],
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal standings-viewer" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal__header">
          <h3>{t('admin.access.svTitle')}</h3>
          <button className="modal__close" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={14} weight="bold" />
          </button>
        </div>

        {bothSources && (
          <div className="standings-viewer__sources">
            {(['corp', 'alliance'] as SourceKind[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`standings-viewer__source${source === s ? ' standings-viewer__source--active' : ''}`}
                onClick={() => setSource(s)}
              >
                {t(s === 'corp' ? 'admin.access.svSourceCorp' : 'admin.access.svSourceAlliance')}
              </button>
            ))}
          </div>
        )}

        <div className="standings-viewer__tabs">
          {BANDS.map((b) => (
            <button
              key={b.key}
              type="button"
              className={`standings-viewer__tab ${b.cls}${band === b.key ? ' standings-viewer__tab--active' : ''}`}
              onClick={() => setBand(b.key)}
            >
              <span className="standings-viewer__tab-label">{t(b.labelKey)}</span>
              <span className="standings-viewer__tab-count">{counts[b.key] ?? 0}</span>
            </button>
          ))}
        </div>

        <div className="modal__body standings-viewer__body">
          {loading && <div className="standings-viewer__msg">{t('admin.access.svLoading')}</div>}
          {error   && <div className="standings-viewer__msg standings-viewer__msg--error">{error}</div>}
          {!loading && !error && rows.length === 0 && (
            <div className="standings-viewer__msg">{t('admin.access.svEmpty')}</div>
          )}
          {!loading && !error && rows.length > 0 && (
            <table className="standings-viewer__table">
              <thead>
                <tr>
                  <th className="standings-viewer__col-name">{t('admin.access.svColName')}</th>
                  <th className="standings-viewer__col-ticker">{t('admin.access.svColTicker')}</th>
                  <th className="standings-viewer__col-standing">{t('admin.access.svColStanding')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={`${c.contactKind}:${c.id}`}>
                    <td className="standings-viewer__col-name">
                      <img
                        className="standings-viewer__logo"
                        src={c.contactKind === 'corporation' ? corpLogo(c.id, 32) : allianceLogo(c.id, 32)}
                        alt=""
                        loading="lazy"
                      />
                      <span className="standings-viewer__name" title={String(c.id)}>{c.name}</span>
                    </td>
                    <td className="standings-viewer__col-ticker">{c.ticker ? `[${c.ticker}]` : '--'}</td>
                    <td className={`standings-viewer__col-standing ${active.cls}`}>
                      {c.standing > 0 ? `+${c.standing.toFixed(1)}` : c.standing.toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
