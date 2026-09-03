import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { charPortrait } from '../../utils/eveImages';
import { usePilotsOnline } from '../../hooks/usePilotsOnline';
import { useSystemAlias } from '../../hooks/useSystemAlias';
import { timeAgo } from '../../i18n/format';
import { DASH } from '../../i18n/format';

// Corp/alliance pilots Nexum has seen in the last few minutes: who, what they
// were flying, and where they were.
//
// The age is shown on every row on purpose. This list is inferred from when a
// pilot's client last reported in, not from asking ESI who is logged in, so a
// row means "was here two minutes ago" rather than "is here now". Showing the
// age keeps the panel honest instead of implying a liveness it doesn't have.
export function PilotsOnlinePane() {
  const { t } = useTranslation();
  const aliasName = useSystemAlias();
  const pilots = usePilotsOnline();
  const [query, setQuery] = useState('');

  // Re-render on a slow tick so "2m ago" doesn't sit there going stale between
  // 30 s polls.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pilots;
    return pilots.filter((p) =>
      p.characterName.toLowerCase().includes(q)
      || (p.systemName ?? '').toLowerCase().includes(q)
      || (p.shipTypeName ?? '').toLowerCase().includes(q));
  }, [pilots, query]);

  if (pilots.length === 0) {
    return <div className="scout-pane__empty">{t('pilotsOnline.none')}</div>;
  }

  return (
    <div className="fleet-pane">
      <input
        type="text"
        className="fleet-pane__search"
        placeholder={t('pilotsOnline.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label={t('pilotsOnline.searchPlaceholder')}
      />

      {rows.length === 0 ? (
        <div className="scout-pane__empty">{t('pilotsOnline.noMatches')}</div>
      ) : (
        <ul className="fleet-pane__list">
          {rows.map((p) => {
            const ship = p.shipTypeName
              ? (p.shipName && p.shipName !== p.shipTypeName
                  ? `${p.shipTypeName} · ${p.shipName}`
                  : p.shipTypeName)
              : null;
            const where = p.systemName ? aliasName(p.systemName) : null;
            return (
              <li key={p.characterId} className="fleet-pane__row">
                <img
                  className="fleet-pane__avatar"
                  src={charPortrait(p.characterId, 32)}
                  alt=""
                  loading="lazy"
                />
                <span className="fleet-pane__name" title={p.characterName}>{p.characterName}</span>
                <span className="fleet-pane__loc" title={ship ?? undefined}>
                  {ship ?? DASH}
                </span>
                <span
                  className="fleet-pane__loc"
                  title={p.regionName ? `${where} — ${p.regionName}` : undefined}
                >
                  {where ?? t('pilotsOnline.unknownLoc')}
                </span>
                <span className="fleet-pane__jumps" title={new Date(p.lastSeenAt).toLocaleString()}>
                  {timeAgo(t, new Date(p.lastSeenAt))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
