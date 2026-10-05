import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: vi.fn().mockResolvedValue({}) }));

import {
  seedUserSettings, readUserSetting, writeUserSetting, _resetUserSettingsForTests,
} from './useUserSetting';

const KEY = 'nexum.sidebar.order';
const ORG  = ['watchlist', 'chains'];
const MINE = ['chains', 'watchlist'];
const CODE = ['closest'];

describe('org default settings', () => {
  beforeEach(() => { _resetUserSettingsForTests(); localStorage.clear(); });

  it('falls back to the org default when the user has no value', () => {
    seedUserSettings({}, { [KEY]: ORG });
    expect(readUserSetting(KEY, CODE)).toEqual(ORG);
  });

  it('lets the user own value win, which is the whole point', () => {
    seedUserSettings({ [KEY]: MINE }, { [KEY]: ORG });
    expect(readUserSetting(KEY, CODE)).toEqual(MINE);
  });

  it('falls through to the shipped default when the org has set none', () => {
    seedUserSettings({}, {});
    expect(readUserSetting(KEY, CODE)).toEqual(CODE);
  });

  it('stops applying to a key the moment the user changes it', () => {
    seedUserSettings({}, { [KEY]: ORG });
    expect(readUserSetting(KEY, CODE)).toEqual(ORG);
    writeUserSetting(KEY, MINE);
    expect(readUserSetting(KEY, CODE)).toEqual(MINE);
  });

  it('returns the same reference on every read', () => {
    // getSnapshot is this read path and useSyncExternalStore throws "The result
    // of getSnapshot should be cached" if an object identity changes between
    // reads. Most of these values are arrays, so a copy here would break every
    // consumer at once.
    seedUserSettings({}, { [KEY]: ORG });
    expect(readUserSetting(KEY, CODE)).toBe(readUserSetting(KEY, CODE));
  });

  it('does not block a pre-database localStorage value from migrating up', () => {
    // The migration only uploads keys ABSENT from the cache. If org defaults
    // were merged into the cache they would occupy the slot and the user's own
    // stored value would be dropped on the floor -- silent, one-way data loss.
    localStorage.setItem(KEY, JSON.stringify(MINE));
    seedUserSettings({}, { [KEY]: ORG });
    expect(readUserSetting(KEY, CODE)).toEqual(MINE);
  });

  it('is cleared between tests so defaults cannot leak', () => {
    seedUserSettings({}, { [KEY]: ORG });
    _resetUserSettingsForTests();
    expect(readUserSetting(KEY, CODE)).toEqual(CODE);
  });
});
