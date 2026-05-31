import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../../store/mapStore';
import { useRoute } from '../../hooks/useRoute';
import type { SystemClass } from '../../types';

// Jita IV-Moon 4 system id. Hardcoded elsewhere in the app — see
// ClosestSystemsPane.DEFAULT_HUBS.
const JITA_SYSTEM_ID = 30000142;

type ExitClass = 'HS' | 'LS' | 'NS';

const EXIT_CLASSES: ExitClass[] = ['HS', 'LS', 'NS'];
const EXIT_COLOR: Record<ExitClass, string> = {
  HS: '#4dd9ac',
  LS: '#f0a030',
  NS: '#e05a5a',
};

function isExitClass(c: SystemClass): c is ExitClass {
  return c === 'HS' || c === 'LS' || c === 'NS';
}

interface ExitRow {
  id:        string;
  eveId:     number;
  name:      string;
  klass:     ExitClass;
  jumps:     number | null;
}

export function ChainExitsSection() {
  const { t } = useTranslation();
  const systems = useMapStore((s) => s.map.systems);
  const exitLabel: Record<ExitClass, string> = {
    HS: t('chainExits.highSec'),
    LS: t('chainExits.lowSec'),
    NS: t('chainExits.nullSec'),
  };

  // Pull every K-space system on the map that has a resolved EVE id (synthetic
  // systems without one can't be routed). Ordering doesn't matter here —
  // the render pass sorts by class then jumps.
  const exits = useMemo(() => {
    return systems
      .filter((s) => isExitClass(s.systemClass) && s.eveSystemId != null)
      .map((s) => ({
        id:    s.id,
        eveId: s.eveSystemId as number,
        name:  s.name,
        klass: s.systemClass as ExitClass,
      }));
  }, [systems]);

  const counts: Record<ExitClass, number> = { HS: 0, LS: 0, NS: 0 };
  for (const e of exits) counts[e.klass]++;

  // Route from Jita to every exit in one batch. Stargate routes are symmetric
  // so Jita→X has the same jump count as X→Jita, and one call beats N calls
  // through the BFS service.
  const targetIds = useMemo(() => exits.map((e) => e.eveId), [exits]);
  const routes    = useRoute(exits.length > 0 ? JITA_SYSTEM_ID : null, targetIds);

  const rows: ExitRow[] = useMemo(() => {
    return exits.map((e) => ({
      ...e,
      jumps: routes[String(e.eveId)]?.jumps ?? null,
    }));
  }, [exits, routes]);

  // Sort: by class (HS→LS→NS), then by jumps ascending (unknown last).
  const sortedRows = useMemo(() => {
    const classOrder: Record<ExitClass, number> = { HS: 0, LS: 1, NS: 2 };
    return [...rows].sort((a, b) => {
      const c = classOrder[a.klass] - classOrder[b.klass];
      if (c !== 0) return c;
      const aJ = a.jumps ?? Number.POSITIVE_INFINITY;
      const bJ = b.jumps ?? Number.POSITIVE_INFINITY;
      return aJ - bJ;
    });
  }, [rows]);

  // Nearest Jita = the exit whose Jita route is shortest. Skip exits whose
  // route hasn't resolved yet.
  const nearest = useMemo(() => {
    let best: ExitRow | null = null;
    for (const r of rows) {
      if (r.jumps == null) continue;
      if (!best || r.jumps < best.jumps!) best = r;
    }
    return best;
  }, [rows]);

  if (exits.length === 0) {
    return (
      <div className="map-sidebar__hint">
        {t('chainExits.noExits')}
      </div>
    );
  }

  return (
    <>
      <div className="map-sidebar__hint">
        {t('chainExits.hint')}
      </div>

      <div className="chain-exits__chips">
        {EXIT_CLASSES.map((c) => (
          <span
            key={c}
            className="chain-exits__chip"
            style={{ borderColor: EXIT_COLOR[c], color: EXIT_COLOR[c] }}
          >
            <strong>{counts[c]}</strong> {exitLabel[c]}
          </span>
        ))}
      </div>

      {nearest && (
        <div className="chain-exits__nearest">
          {t('chainExits.nearestJita')}{' '}
          <strong>{nearest.jumps}j</strong> {t('chainExits.via')}{' '}
          <span style={{ color: EXIT_COLOR[nearest.klass] }}>{nearest.name}</span>
        </div>
      )}

      <ul className="chain-exits__list">
        {sortedRows.map((r) => (
          <li key={r.id} className="chain-exits__row">
            <span
              className="chain-exits__dot"
              style={{ background: EXIT_COLOR[r.klass] }}
            />
            <span className="chain-exits__name">{r.name}</span>
            <span className="chain-exits__jumps">
              {r.jumps == null ? '…' : `${r.jumps}j`}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
