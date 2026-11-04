import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../api/client', () => ({ api: vi.fn().mockResolvedValue({}) }));

import {
  seedUserSettings, readUserSetting, writeUserSetting, applyRemoteSettings, _resetUserSettingsForTests,
} from './useUserSetting';
import { api } from '../api/client';

const KEY = 'nexum.closestSystems.list';

describe('settings changed elsewhere', () => {
  beforeEach(() => {
    _resetUserSettingsForTests();
    localStorage.clear();
    vi.mocked(api).mockClear();
    vi.useFakeTimers();
  });

  it('adopts the new value without saving it back', () => {
    seedUserSettings({ [KEY]: [1] });
    applyRemoteSettings({ [KEY]: [2] });
    expect(readUserSetting(KEY, [])).toEqual([2]);
    expect(localStorage.getItem(KEY)).toBe('[2]');
    vi.runAllTimers();
    expect(api).not.toHaveBeenCalled();
  });

  it('keeps an unsent local edit over the incoming value', () => {
    seedUserSettings({ [KEY]: [1] });
    writeUserSetting(KEY, [3]);
    applyRemoteSettings({ [KEY]: [2] });
    expect(readUserSetting(KEY, [])).toEqual([3]);
  });
});
