import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ api }));
vi.mock('react-i18next', () => ({
  // Echo the key plus its interpolation values, so assertions don't depend on
  // English wording.
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
    i18n: { language: 'en' },
  }),
  // routeActions pulls in the i18n bootstrap, which registers this plugin at
  // import time -- without it the module graph fails before any test runs.
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

// The route itself is fetched by useRoute, which has its own tests. Stub it so
// these cases are about the pane's own behaviour: what it asks for and what it
// renders back.
const useRoute = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useRoute', () => ({ useRoute }));

const useRouteOrigin = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useRouteOrigin', () => ({ useRouteOrigin }));

const useEsiSearch = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useEsiSearch', () => ({
  useEsiSearch,
  systemResultLabel: (r: { regionName?: string }) => r.regionName ?? '',
}));

vi.mock('../../store/mapStore', () => ({
  useMapStore: (sel: (s: unknown) => unknown) => sel({ routeMode: 'shortest' }),
}));

// RouteSquares brings its own context menu and alias lookups; the pane only
// needs to hand it a route, so assert on the squares it emits.
vi.mock('./routeUi', () => ({
  RouteSquares: ({ route }: { route: { path: unknown[] } }) => (
    <div data-testid="squares">{route.path.length}</div>
  ),
}));

import { RoutePlannerPane } from './RoutePlannerPane';

const JITA  = { id: 30000142, name: 'Jita',  security: 0.9, systemClass: 'HS', regionName: 'The Forge' };
const AMARR = { id: 30002187, name: 'Amarr', security: 1.0, systemClass: 'HS', regionName: 'Domain' };

const ROUTE = {
  jumps: 45,
  path: [{ id: 30000142, name: 'Jita', security: 0.9, kspace: true },
         { id: 30002187, name: 'Amarr', security: 1.0, kspace: true }],
  usesSpecial: false,
};

function setUp(opts: {
  origin?: { systemId: number | null; name: string | null; fromLastKnown?: boolean; characterName?: string | null };
  results?: unknown[];
  routes?: Record<string, unknown>;
} = {}) {
  useRouteOrigin.mockReturnValue({
    systemId: null, name: null, fromLastKnown: false, characterName: null, ...opts.origin,
  });
  useEsiSearch.mockReturnValue({ results: opts.results ?? [], loading: false, error: null });
  useRoute.mockReturnValue(opts.routes ?? {});
  api.mockResolvedValue([]);              // saved-plans list
}

describe('RoutePlannerPane', () => {
  beforeEach(() => { api.mockReset(); useRoute.mockReset(); useRouteOrigin.mockReset(); useEsiSearch.mockReset(); });

  it('asks for nothing until both ends are chosen', async () => {
    setUp();
    render(<RoutePlannerPane />);
    await waitFor(() => expect(screen.getByText('routePlanner.pickBoth')).toBeTruthy());
    // An empty target list is what stops useRoute hitting /api/route.
    expect(useRoute).toHaveBeenCalledWith(null, []);
  });

  it('starts from the pilot location without making them pick it', async () => {
    setUp({ origin: { systemId: JITA.id, name: 'Jita' } });
    render(<RoutePlannerPane />);
    await waitFor(() => expect(screen.getByText('Jita')).toBeTruthy());
    // Origin known, destination not: still no route request.
    expect(useRoute).toHaveBeenCalledWith(JITA.id, []);
  });

  it('routes once a destination is picked, and renders the jumps and the path', async () => {
    setUp({
      origin:  { systemId: JITA.id, name: 'Jita' },
      results: [AMARR],
      routes:  { [String(AMARR.id)]: ROUTE },
    });
    const { container } = render(<RoutePlannerPane />);

    // Control: the destination search is actually open and offering Amarr, so
    // the assertions below can't pass vacuously.
    const input = container.querySelectorAll('input')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Ama' } });
    const option = await screen.findByText('Amarr');
    fireEvent.click(option);

    await waitFor(() => expect(useRoute).toHaveBeenLastCalledWith(JITA.id, [AMARR.id]));
    expect(screen.getByText(/units\.jumps.*45/)).toBeTruthy();
    expect(screen.getByTestId('squares').textContent).toBe('2');
  });

  it('says so when the two ends are the same system rather than asking for a route', async () => {
    setUp({ origin: { systemId: JITA.id, name: 'Jita' }, results: [JITA] });
    const { container } = render(<RoutePlannerPane />);
    const input = container.querySelectorAll('input')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Jit' } });
    fireEvent.click(await screen.findByText('Jita', { selector: '.search-results__item' }));

    await waitFor(() => expect(screen.getByText('routePlanner.sameSystem')).toBeTruthy());
    expect(useRoute).toHaveBeenLastCalledWith(JITA.id, []);
  });

  it('reports no route when the engine omits the target', async () => {
    // The engine leaves unreachable targets out of the response rather than
    // returning a zero-jump entry, so an absent key is the "no route" signal.
    setUp({ origin: { systemId: JITA.id, name: 'Jita' }, results: [AMARR], routes: {} });
    const { container } = render(<RoutePlannerPane />);
    const input = container.querySelectorAll('input')[0] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Ama' } });
    fireEvent.click(await screen.findByText('Amarr'));
    await waitFor(() => expect(screen.getByText('routePlanner.noRoute')).toBeTruthy());
  });

  it('loads a saved route back into both ends', async () => {
    setUp({ origin: { systemId: JITA.id, name: 'Jita' }, routes: { [String(AMARR.id)]: ROUTE } });
    api.mockResolvedValue([
      { id: 'p1', name: 'Trade run', fromEveId: JITA.id, toEveId: AMARR.id, fromName: 'Jita', toName: 'Amarr' },
    ]);
    render(<RoutePlannerPane />);

    const chip = await screen.findByText('Trade run');
    fireEvent.click(chip);
    await waitFor(() => expect(useRoute).toHaveBeenLastCalledWith(JITA.id, [AMARR.id]));
  });

  it('saves the current pair under the typed name', async () => {
    setUp({ origin: { systemId: JITA.id, name: 'Jita' }, results: [AMARR], routes: { [String(AMARR.id)]: ROUTE } });
    const { container } = render(<RoutePlannerPane />);
    const search = container.querySelectorAll('input')[0] as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'Ama' } });
    fireEvent.click(await screen.findByText('Amarr'));

    const nameBox = await waitFor(() => {
      const el = [...container.querySelectorAll('input')]
        .find((i) => i.getAttribute('placeholder') === 'routePlanner.nameToSave');
      if (!el) throw new Error('save box not rendered');
      return el as HTMLInputElement;
    });
    fireEvent.change(nameBox, { target: { value: 'Trade run' } });
    fireEvent.click(screen.getByText('routePlanner.save'));

    await waitFor(() => {
      const post = api.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(post![1].body)).toEqual({
        name: 'Trade run', fromEveId: JITA.id, toEveId: AMARR.id,
      });
    });
  });
});
