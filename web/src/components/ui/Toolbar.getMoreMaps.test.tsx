import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// The toolbar pulls in a lot of the app. Everything stubbed below is stubbed
// because it does IO or drags in the canvas — none of it decides whether the
// "Get more maps" entry appears. The two things that DO decide it, the store
// flag and the map count, are left real.
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, characterId: 100, characterName: 'Pilot', role: 'full', characters: [] }, logout: vi.fn() }),
  formatRole: (r: string) => r,
  isAdminRole: () => false,
}));
vi.mock('../../api/client', () => ({ api: vi.fn(async () => ({})), apiUrl: (p: string) => p }));
vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => ({ online: true, lastLogin: null }) }));
vi.mock('../../hooks/useCharacterLocation', () => ({
  useCharacterLocation: () => ({ online: true, system: null, ship: null }),
  useCharacterLocationCheckedAt: () => Date.now(),
}));
vi.mock('../../hooks/useSystemAlias', () => ({ useSystemAlias: () => (n: string) => n }));
vi.mock('../../hooks/useCanEdit', () => ({ useCanEdit: () => true }));
vi.mock('../../hooks/useCanEditContent', () => ({ useCanEditContent: () => true }));
vi.mock('../../hooks/useIsMapOwner', () => ({ useIsMapOwner: () => true }));
vi.mock('../../hooks/useCanCreateMaps', () => ({ useCanCreateMaps: () => false, useCanManageAllianceMaps: () => false }));
vi.mock('../../hooks/useProximityAlerts', () => ({ useProximityAlerts: () => ({ alerts: [] }) }));
// useUserSetting is NOT mocked: it is a plain localStorage-backed module that
// works in jsdom, and the map store imports readUserSetting from it at module
// scope — stubbing it only breaks the store.
// Modals and panels that would each drag in their own subtree.
vi.mock('./UserStatsModal',    () => ({ UserStatsModal:    () => null }));
vi.mock('./GetMoreMapsModal',  () => ({ GetMoreMapsModal:  () => <div>get-more-maps-modal</div> }));
vi.mock('./ConfirmModal',      () => ({ ConfirmModal:      () => null }));
vi.mock('./CreateMapModal',    () => ({ CreateMapModal:    () => null }));
vi.mock('./CopyMapModal',      () => ({ CopyMapModal:      () => null }));
vi.mock('./ApiKeysModal',      () => ({ ApiKeysModal:      () => null }));
vi.mock('./LanguageSwitcher',  () => ({ LanguageSwitcher:  () => null }));
vi.mock('./CharacterSwitcher', () => ({ CharacterSwitcher: () => null }));
vi.mock('./HeatmapMenu',       () => ({ HeatmapMenu:       () => null }));
vi.mock('./WhTypeChartModal',  () => ({ WhTypeChartModal:  () => null }));
vi.mock('./KillLogPanel',      () => ({ KillLogPanel:      () => null }));
vi.mock('./JumpPlannerModal',  () => ({ JumpPlannerModal:  () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en', changeLanguage: vi.fn() } }),
}));

import { Toolbar } from './Toolbar';
import { useMapStore } from '../../store/mapStore';

function personalMaps(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`, name: `Map ${i}`,
    isCorpMap: false, isAllianceMap: false, sharedWithMe: false, locked: false,
  }));
}

// Put the store in a known state: `count` personal maps against a cap of 5.
function setUp(count: number, iskMapsEnabled: boolean) {
  useMapStore.setState({
    maps: personalMaps(count) as never,
    maxMaps: 5,
    iskMapsEnabled,
    activeMapId: 'm0',
  } as never);
}

// The entry is meant to appear ONLY when the pilot has actually run out AND the
// deployment offers it. The second half is what keeps it off corp and alliance
// installs, which manage their own limits.
// The entry lives INSIDE the map dropdown, which starts closed. Without opening
// it every assertion below would pass for the wrong reason — the negative cases
// would be finding nothing simply because nothing is rendered yet.
function renderWithMenuOpen() {
  const r = render(<Toolbar />);
  fireEvent.click(r.container.querySelector('.toolbar__map-name-btn')!);
  return r;
}

describe('Toolbar — "Get more maps"', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('the menu actually opens, so the assertions below mean something', () => {
    setUp(2, true);
    renderWithMenuOpen();
    expect(screen.queryByText('toolbar.newMap')).not.toBeNull();
  });

  it('is absent while the pilot still has map slots left', () => {
    setUp(2, true);
    renderWithMenuOpen();
    expect(screen.queryByText('toolbar.getMoreMaps')).toBeNull();
  });

  it('appears once the pilot is at their cap', () => {
    setUp(5, true);
    renderWithMenuOpen();
    expect(screen.queryByText('toolbar.getMoreMaps')).not.toBeNull();
  });

  it('stays hidden at the cap when the deployment does not offer it', () => {
    setUp(5, false);
    renderWithMenuOpen();
    expect(screen.queryByText('toolbar.getMoreMaps')).toBeNull();
  });

  it('stays hidden when over the cap but the deployment does not offer it', () => {
    setUp(9, false);
    renderWithMenuOpen();
    expect(screen.queryByText('toolbar.getMoreMaps')).toBeNull();
  });
});
