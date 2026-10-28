import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { XIcon } from '../../icons';
import { api } from '../../api/client';
import { charPortrait } from '../../utils/eveImages';
import { timeAgo, europeanDate } from '../../i18n/format';
import { Select } from './Select';
import styles from './MapAuditModal.module.css';

interface AuditEntry {
  id:            string;
  createdAt:     string;
  action:        string;
  subject:       string | null;
  details:       { fields?: string[]; values?: Record<string, unknown> } | null;
  characterId:   number | null;
  characterName: string | null;
  viaApi:        boolean;
}

interface AuditPage {
  entries:       AuditEntry[];
  more:          boolean;
  retentionDays: number;
}

const KINDS = ['system', 'connection', 'signature', 'anomaly', 'structure', 'chain', 'map', 'share'] as const;
type Kind = typeof KINDS[number] | 'all';

// Field and value labels fall back to the raw key, so a field added on the
// server later still reads (just untranslated) rather than disappearing.
function fieldLabel(t: TFunction, field: string): string {
  return t(`audit.field.${field}` as 'audit.field.name', { defaultValue: field });
}

function valueText(t: TFunction, v: unknown): string {
  if (v === true)  return t('audit.on');
  if (v === false) return t('audit.off');
  if (v === null || v === '') return t('audit.cleared');
  return String(v);
}

// "Mass: critical · Name" — fields with a recorded value show it; the rest
// (names, notes) are listed by name only.
function detailText(t: TFunction, e: AuditEntry): string {
  const values = e.details?.values ?? {};
  const fields = e.details?.fields ?? Object.keys(values);
  return fields
    .map((f) => (f in values ? `${fieldLabel(t, f)}: ${valueText(t, values[f])}` : fieldLabel(t, f)))
    .join(' · ');
}

interface Props { mapId: string; mapName: string; onClose: () => void; }

export function MapAuditModal({ mapId, mapName, onClose }: Props) {
  const { t } = useTranslation();
  const [kind, setKind]       = useState<Kind>('all');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [more, setMore]       = useState(false);
  const [retention, setRetention] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  // Callers set `loading` before calling, so the effect below doesn't set
  // state synchronously.
  const load = useCallback((before: string | null) => {
    const qs = new URLSearchParams();
    if (before) qs.set('before', before);
    if (kind !== 'all') qs.set('kind', kind);
    return api<AuditPage>(`/api/maps/${mapId}/audit${qs.size ? `?${qs}` : ''}`)
      .then((page) => {
        setEntries((cur) => (before ? [...cur, ...page.entries] : page.entries));
        setMore(page.more);
        setRetention(page.retentionDays);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [mapId, kind]);

  useEffect(() => { void load(null); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${styles.modal}`} role="dialog" aria-modal="true" aria-label={t('audit.title')}>
        <div className="modal__header">
          <h2 className="modal__title">{t('audit.titleFor', { name: mapName })}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={14} weight="bold" />
          </button>
        </div>

        <div className={styles.toolbar}>
          <span className="map-sidebar__hint">{t('audit.hint', { days: retention })}</span>
          <Select
            value={kind}
            onChange={(v) => { setLoading(true); setEntries([]); setKind(v as Kind); }}
            ariaLabel={t('audit.filter')}
            options={[
              { value: 'all', label: t('audit.kind.all') },
              ...KINDS.map((k) => ({ value: k, label: t(`audit.kind.${k}` as 'audit.kind.all') })),
            ]}
          />
        </div>

        <div className={`modal__body ${styles.body}`}>
          {error && <div className="map-sidebar__hint map-sidebar__hint--error">{error}</div>}
          {!error && !loading && entries.length === 0 && (
            <div className={styles.empty}>{t('audit.empty')}</div>
          )}
          <ol className={styles.list}>
            {entries.map((e) => {
              const when = new Date(e.createdAt);
              const detail = detailText(t, e);
              return (
                <li key={e.id} className={styles.row}>
                  {e.characterId
                    ? <img className={styles.portrait} src={charPortrait(e.characterId, 32)} alt="" loading="lazy" />
                    : <span className={styles.portrait} aria-hidden="true" />}
                  <div className={styles.main}>
                    <div className={styles.line}>
                      <span className={styles.who}>{e.characterName ?? t('audit.unknownPilot')}</span>
                      {e.viaApi && <span className={styles.api}>{t('audit.viaApi')}</span>}
                      <span className={styles.what}>
                        {t(`audit.action.${e.action}` as 'audit.action.system.add', {
                          subject: e.subject ?? '?',
                          defaultValue: `${e.action} ${e.subject ?? ''}`.trim(),
                        })}
                      </span>
                    </div>
                    {detail && <div className={styles.detail}>{detail}</div>}
                  </div>
                  <time
                    className={styles.when}
                    dateTime={e.createdAt}
                    title={`${europeanDate(when)} ${when.toLocaleTimeString()}`}
                  >
                    {timeAgo(t, when)}
                  </time>
                </li>
              );
            })}
          </ol>
          {loading && <div className={styles.empty}>{t('audit.loading')}</div>}
          {more && !loading && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => { setLoading(true); void load(entries[entries.length - 1]?.id ?? null); }}
            >
              {t('audit.loadMore')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
