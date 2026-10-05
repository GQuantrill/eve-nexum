import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

const useRoute = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useRoute', () => ({ useRoute }));

const useClosestSystemsList = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useClosestSystems', () => ({ useClosestSystemsList }));

const systems = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('../../store/mapStore', () => ({
  useMapStore: (sel: (s: unknown) => unknown) => sel({ map: { systems: systems.list } }),
}));

vi.mock('../../utils/systemName', () => ({ systemDisplayName: (s: { name: string }) => s.name }));
vi.mock('../../i18n/format', () => ({ jumps: (_t: unknown, n: number) => `${n}j` }));

import { ChainExitsMenu } from './ChainExitsMenu';

const JITA = 30000142, AMARR = 30002187;

// Two high-sec exits and a null-sec one, so the counts are distinguishable.
const MAP_SYSTEMS = [
  { id: 'a', eveSystemId: 30000001, name: 'Exit-HS-1', systemClass: 'HS' },
  { id: 'b', eveSystemId: 30000002, name: 'Exit-HS-2', systemClass: 'HS' },
  { id: 'c', eveSystemId: 30000003, name: 'Exit-NS-1', systemClass: 'NS' },
  // J-space and id-less systems are not exits and must not be counted.
  { id: 'd', eveSystemId: 31000001, name: 'J123456',   systemClass: 'C3' },
  { id: 'e', eveSystemId: null,     name: 'Unknown',   systemClass: 'HS' },
];

function openMenu() {
  fireEvent.click(screen.getByRole('button'));
}

describe('ChainExitsMenu', () => {
  beforeEach(() => {
    useRoute.mockReset();
    useClosestSystemsList.mockReset();
    systems.list = MAP_SYSTEMS;
    useClosestSystemsList.mockReturnValue([{ id: JITA, name: 'Jita', isHome: false }]);
    useRoute.mockReturnValue({});
  });

  it('shows the exit counts without asking for a single route', () => {
    const { container } = render(<ChainExitsMenu />);
    const badge = container.querySelector('.chain-exits-menu__badge')!;
    // HS, LS, NS in order: the J-space system and the one with no EVE id are
    // excluded, which is the part worth pinning.
    expect([...badge.querySelectorAll('span')].map((s) => s.textContent)).toEqual(['2', '0', '1']);
    // The whole justification for the badge is that it costs nothing.
    expect(useRoute).not.toHaveBeenCalled();
  });

  it('routes only once the popover is opened', () => {
    render(<ChainExitsMenu />);
    expect(useRoute).not.toHaveBeenCalled();
    openMenu();
    expect(useRoute).toHaveBeenCalled();
  });

  it('names the exit that reaches a favourite in fewest jumps', async () => {
    useRoute.mockReturnValue({
      '30000001': { jumps: 12, path: [], usesSpecial: false },
      '30000002': { jumps: 4,  path: [], usesSpecial: false },   // the winner
      '30000003': { jumps: 30, path: [], usesSpecial: false },
    });
    const { container } = render(<ChainExitsMenu />);
    openMenu();

    // Control: the favourite's row rendered at all.
    expect(await screen.findByText('Jita')).toBeTruthy();
    // Scoped to the favourite row -- every exit name also appears in the
    // all-exits list below, so an unscoped query matches twice and would pass
    // even if the wrong exit had won.
    const row = container.querySelector('.chain-exits-menu__fav-route')!;
    expect(row.textContent).toContain('4j');
    expect(row.textContent).toContain('Exit-HS-2');
    expect(row.textContent).not.toContain('Exit-HS-1');
  });

  it('routes once per favourite, from the favourite outward', () => {
    useClosestSystemsList.mockReturnValue([
      { id: JITA,  name: 'Jita',  isHome: false },
      { id: AMARR, name: 'Amarr', isHome: true  },
    ]);
    render(<ChainExitsMenu />);
    openMenu();
    const origins = useRoute.mock.calls.map((c) => c[0]);
    expect(origins).toContain(JITA);
    expect(origins).toContain(AMARR);
  });

  it('says so when a favourite cannot be reached from any exit', async () => {
    useRoute.mockReturnValue({});          // engine omits unreachable targets
    render(<ChainExitsMenu />);
    openMenu();
    expect(await screen.findByText('chainExits.noRoute')).toBeTruthy();
  });

  it('marks a favourite that is itself an exit rather than routing to it', async () => {
    systems.list = [{ id: 'a', eveSystemId: JITA, name: 'Jita', systemClass: 'HS' }];
    render(<ChainExitsMenu />);
    openMenu();
    expect(await screen.findByText('chainExits.inChain')).toBeTruthy();
  });

  it('reports an empty chain instead of an empty favourites list', async () => {
    systems.list = [];
    render(<ChainExitsMenu />);
    openMenu();
    expect(await screen.findByText('chainExits.noExits')).toBeTruthy();
  });

  it('points at the Closest Systems panel when nothing is favourited', async () => {
    useClosestSystemsList.mockReturnValue([]);
    render(<ChainExitsMenu />);
    openMenu();
    expect(await screen.findByText('chainExits.noFavourites')).toBeTruthy();
  });
});
