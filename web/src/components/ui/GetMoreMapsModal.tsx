import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { XIcon, CopyIcon, CheckIcon } from '../../icons';

interface Donation { amount: string | number; occurredAt: string }

interface Allowance {
  used: number; cap: number; base: number;
  donated: number; toNext: number;
  priceIsk: number; perGrant: number;
  enabled: boolean;
  corpId: number | null;
  corpName: string | null;
  donations: Donation[];
}

// Whole ISK with thousands separators, in the user's locale.
function isk(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
}

/**
 * Instructions for trading ISK for extra personal maps, plus what this account
 * has already contributed.
 *
 * Deliberately explicit about two things people would otherwise get wrong: the
 * donation must come from a character linked to their account (that is how it
 * gets matched), and it is not instant — EVE only publishes the corporation
 * wallet hourly, so a promise of "immediately" would generate support tickets.
 */
export function GetMoreMapsModal({ onClose }: { onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const [data, setData]   = useState<Allowance | null>(null);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api<Allowance>('/api/maps/allowance')
      .then((d) => { if (alive) setData(d); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  // Comes from the server (resolved from the configured corp id), so this
  // works for any deployment rather than naming one corporation in code.
  const corpName = data?.corpName ?? (data?.corpId ? String(data.corpId) : '');

  async function copyCorp() {
    if (!data?.corpId) return;
    try {
      await navigator.clipboard.writeText(corpName);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the name is on screen to type anyway */ }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('getMoreMaps.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          {error && <div className="map-sidebar__hint map-sidebar__hint--error">{t('getMoreMaps.loadFailed')}</div>}

          {data && (
            <>
              <div className="map-sidebar__hint">
                {t('getMoreMaps.using', { used: data.used, cap: data.cap })}
              </div>

              <p>{t('getMoreMaps.intro', {
                amount: isk(data.priceIsk, i18n.language),
                maps:   data.perGrant,
                corp:   corpName,
              })}</p>

              <ol className="get-more-maps__steps">
                <li>{t('getMoreMaps.step1', { corp: corpName })}</li>
                <li>{t('getMoreMaps.step2', { amount: isk(data.priceIsk, i18n.language) })}</li>
                <li>{t('getMoreMaps.step3')}</li>
              </ol>

              <div className="field">
                <span>{t('getMoreMaps.recipient')}</span>
                <div className="get-more-maps__corp">
                  <code>{corpName}</code>
                  <button type="button" className="icon-btn" onClick={copyCorp} aria-label={t('getMoreMaps.copyCorp')}>
                    {copied ? <CheckIcon size={14} weight="bold" /> : <CopyIcon size={14} weight="bold" />}
                  </button>
                </div>
              </div>

              <div className="map-sidebar__hint">{t('getMoreMaps.timing')}</div>
              <div className="map-sidebar__hint">{t('getMoreMaps.mustBeLinked')}</div>

              {data.donated > 0 && (
                <>
                  <div className="map-sidebar__hint">
                    {t('getMoreMaps.contributed', { amount: isk(data.donated, i18n.language) })}
                    {' '}
                    {t('getMoreMaps.toNext', { amount: isk(data.toNext, i18n.language), maps: data.perGrant })}
                  </div>
                  <ul className="get-more-maps__history">
                    {data.donations.map((d, i) => (
                      <li key={i}>
                        <span>{new Date(d.occurredAt).toLocaleDateString(i18n.language)}</span>
                        <span>{isk(Number(d.amount), i18n.language)} ISK</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          <div className="modal__actions">
            <button type="button" className="btn btn--primary" onClick={onClose}>{t('actions.close')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
