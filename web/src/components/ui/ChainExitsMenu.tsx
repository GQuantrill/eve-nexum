import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMapStore } from '../../store/mapStore';
import { useRoute } from '../../hooks/useRoute';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useClosestSystemsList } from '../../hooks/useClosestSystems';
import { systemDisplayName } from '../../utils/systemName';
import { jumps as jumpsLabel } from '../../i18n/format';
import { SignOutIcon } from '../../icons';
import type { SystemClass } from '../../types';

// Where your chain lets you out, and which exit gets you nearest the places you
// care about.
//
// This used to be a section inside the Map Options drawer, which buried it
// twice: behind the drawer, and behind a single-open accordion, so reading it
// closed whatever else you had open. It also measured everything against a
// hardcoded Jita, which only answers the question if Jita is where you're going.
//
// Now: the toolbar button carries the counts (no routing, so it costs nothing
// to show), and the popover answers the real question per favourite system --
// "Amarr: 9 jumps, via this hole".

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

interface Exit { id: string; eveId: number; name: string; klass: ExitClass }

/**
 * One favourite system, and the chain exit that reaches it in fewest jumps.
 *
 * A component per favourite because useRoute takes a single origin and hooks
 * can't be looped -- the same shape ChainsPane's ChainExitDistances uses. Gate
 * routes are symmetric, so routing favourite -> exits answers the same question
 * as exits -> favourite, and favourites are the smaller, bounded side (one
 * request each, versus one per exit).
 */
function FavouriteRow({ fav, exits }: { fav: { id: number; name: string; isHome: boolean }; exits: Exit[] }) {
  const { t } = useTranslation();
  // Never route a favourite to itself: an exit that IS the hub is zero jumps,
  // which is correct but reads as a bug next to the others.
  const targets = useMemo(() => exits.filter((e) => e.eveId !== fav.id).map((e) => e.eveId), [exits, fav.id]);
  const routes  = useRoute(fav.id, targets);

  const best = useMemo(() => {
    let found: { exit: Exit; jumps: number } | null = null;
    for (const e of exits) {
      const j = routes[String(e.eveId)]?.jumps;
      if (j == null) continue;
      if (!found || j < found.jumps) found = { exit: e, jumps: j };
    }
    return found;
  }, [exits, routes]);

  // The favourite is itself one of the exits — you're already there.
  const selfExit = exits.find((e) => e.eveId === fav.id);

  return (
    <li className="chain-exits-menu__fav">
      <span className="chain-exits-menu__fav-name">{fav.name}</span>
      {selfExit ? (
        <span className="chain-exits-menu__fav-route chain-exits-menu__fav-route--in">
          {t('chainExits.inChain')}
        </span>
      ) : best ? (
        <span className="chain-exits-menu__fav-route">
          <strong>{jumpsLabel(t, best.jumps)}</strong>{' '}
          <span className="chain-exits-menu__via">{t('chainExits.via')}</span>{' '}
          <span style={{ color: EXIT_COLOR[best.exit.klass] }}>{best.exit.name}</span>
        </span>
      ) : (
        <span className="chain-exits-menu__fav-route chain-exits-menu__fav-route--none">
          {t('chainExits.noRoute')}
        </span>
      )}
    </li>
  );
}

export function ChainExitsMenu() {
  const { t } = useTranslation();
  const systems = useMapStore((s) => s.map.systems);
  const favourites = useClosestSystemsList();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useClickOutside(open, wrapRef, () => setOpen(false));

  // Every k-space system on the map with a resolved EVE id. Synthetic systems
  // without one can't be routed, so they can't be exits.
  const exits = useMemo<Exit[]>(() => systems
    .filter((s) => isExitClass(s.systemClass) && s.eveSystemId != null)
    .map((s) => ({
      id: s.id,
      eveId: s.eveSystemId as number,
      name: systemDisplayName(s),
      klass: s.systemClass as ExitClass,
    })), [systems]);

  const counts: Record<ExitClass, number> = { HS: 0, LS: 0, NS: 0 };
  for (const e of exits) counts[e.klass]++;

  const exitLabel: Record<ExitClass, string> = {
    HS: t('chainExits.highSec'),
    LS: t('chainExits.lowSec'),
    NS: t('chainExits.nullSec'),
  };

  // Class first (HS -> LS -> NS), then by name, so the list is stable without
  // needing any route data.
  const sortedExits = useMemo(() => {
    const order: Record<ExitClass, number> = { HS: 0, LS: 1, NS: 2 };
    return [...exits].sort((a, b) => order[a.klass] - order[b.klass] || a.name.localeCompare(b.name));
  }, [exits]);

  return (
    <div className="chain-exits-menu" ref={wrapRef}>
      <button
        type="button"
        className={`toolbar__toggle toolbar__toggle--icon toolbar__toggle--prominent${exits.length > 0 ? ' toolbar__toggle--on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-tooltip={t('chainExits.title')}
        aria-label={t('chainExits.title')}
      >
        <SignOutIcon size={18} weight="regular" />
        {/* The badge is the whole point of moving this to the toolbar: counts
            come straight off the map, so they cost no request and are readable
            without opening anything. */}
        <span className="chain-exits-menu__badge">
          {EXIT_CLASSES.map((c) => (
            <span key={c} style={{ color: EXIT_COLOR[c] }}>{counts[c]}</span>
          ))}
        </span>
      </button>

      {open && (
        // Own the pointer inside the popover, or interacting with it reads as a
        // reorder by the surrounding dnd-kit sortable toolbar item.
        <div
          className="chain-exits-menu__pop"
          role="menu"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="chain-exits-menu__chips">
            {EXIT_CLASSES.map((c) => (
              <span
                key={c}
                className="chain-exits-menu__chip"
                style={{ borderColor: EXIT_COLOR[c], color: EXIT_COLOR[c] }}
              >
                <strong>{counts[c]}</strong> {exitLabel[c]}
              </span>
            ))}
          </div>

          {exits.length === 0 ? (
            <div className="chain-exits-menu__empty">{t('chainExits.noExits')}</div>
          ) : (
            <>
              <div className="chain-exits-menu__hint">{t('chainExits.hint')}</div>
              {favourites.length === 0 ? (
                <div className="chain-exits-menu__empty">{t('chainExits.noFavourites')}</div>
              ) : (
                <ul className="chain-exits-menu__favs">
                  {favourites.map((f) => (
                    <FavouriteRow key={f.id} fav={f} exits={exits} />
                  ))}
                </ul>
              )}

              <div className="chain-exits-menu__hint">{t('chainExits.allExits')}</div>
              <ul className="chain-exits-menu__exits">
                {sortedExits.map((e) => (
                  <li key={e.id} className="chain-exits-menu__exit">
                    <span className="chain-exits-menu__dot" style={{ background: EXIT_COLOR[e.klass] }} />
                    <span className="chain-exits-menu__exit-name">{e.name}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
