import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { useSearchKeys } from './useSearchKeys';

const items = [{ name: 'Jita IV' }, { name: 'Jita' }, { name: 'Jitanai' }];
const key = (k: string) => ({ key: k, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLElement>;

describe('useSearchKeys', () => {
  it('Enter picks the exact name, wherever it is listed', () => {
    const onPick = vi.fn();
    const { result } = renderHook(() => useSearchKeys(items, 'jita', (i) => i.name, onPick));
    act(() => result.current.onKeyDown(key('Enter')));
    expect(onPick).toHaveBeenCalledWith({ name: 'Jita' });
  });

  it('Enter picks the first result with no exact match', () => {
    const onPick = vi.fn();
    const { result } = renderHook(() => useSearchKeys(items, 'jit', (i) => i.name, onPick));
    act(() => result.current.onKeyDown(key('Enter')));
    expect(onPick).toHaveBeenCalledWith({ name: 'Jita IV' });
  });

  it('arrows move the pick, and stop at the ends', () => {
    const onPick = vi.fn();
    const { result } = renderHook(() => useSearchKeys(items, 'jit', (i) => i.name, onPick));
    act(() => result.current.onKeyDown(key('ArrowUp')));
    act(() => result.current.onKeyDown(key('ArrowDown')));
    act(() => result.current.onKeyDown(key('ArrowDown')));
    act(() => result.current.onKeyDown(key('ArrowDown')));
    act(() => result.current.onKeyDown(key('Enter')));
    expect(onPick).toHaveBeenCalledWith({ name: 'Jitanai' });
  });

  it('does nothing with no results', () => {
    const onPick = vi.fn();
    const { result } = renderHook(() => useSearchKeys([] as { name: string }[], 'zz', (i) => i.name, onPick));
    act(() => result.current.onKeyDown(key('Enter')));
    expect(onPick).not.toHaveBeenCalled();
    expect(result.current.active).toBe(-1);
  });

  it('skips rows that can\'t be picked', () => {
    const onPick = vi.fn();
    const taken = (i: { name: string }) => i.name === 'Jita IV' || i.name === 'Jita';
    const { result } = renderHook(() => useSearchKeys(items, 'jita', (i) => i.name, onPick, taken));
    expect(result.current.active).toBe(2);
    act(() => result.current.onKeyDown(key('ArrowUp')));
    act(() => result.current.onKeyDown(key('Enter')));
    expect(onPick).toHaveBeenCalledWith({ name: 'Jitanai' });
  });

  it('picks nothing on Enter before anything is typed', () => {
    const onPick = vi.fn();
    const { result } = renderHook(() => useSearchKeys(items, '', (i) => i.name, onPick));
    act(() => result.current.onKeyDown(key('Enter')));
    expect(onPick).not.toHaveBeenCalled();
    act(() => result.current.onKeyDown(key('ArrowDown')));
    act(() => result.current.onKeyDown(key('Enter')));
    expect(onPick).toHaveBeenCalledWith({ name: 'Jita IV' });
  });

  it('opens on the current value before anything is typed', () => {
    const onPick = vi.fn();
    const { result } = renderHook(() => useSearchKeys(items, '', (i) => i.name, onPick, undefined, 1));
    expect(result.current.active).toBe(1);
    act(() => result.current.onKeyDown(key('ArrowDown')));
    act(() => result.current.onKeyDown(key('Enter')));
    expect(onPick).toHaveBeenCalledWith({ name: 'Jitanai' });
  });
});
