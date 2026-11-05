import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useEscapeClose } from './useEscapeClose';

const esc = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));

describe('useEscapeClose', () => {
  it('closes only the most recently opened', () => {
    const under = vi.fn(), over = vi.fn();
    const a = renderHook(() => useEscapeClose(under));
    const b = renderHook(() => useEscapeClose(over));
    esc();
    expect(over).toHaveBeenCalledTimes(1);
    expect(under).not.toHaveBeenCalled();
    b.unmount();
    esc();
    expect(under).toHaveBeenCalledTimes(1);
    a.unmount();
  });

  it('does nothing while inactive', () => {
    const fn = vi.fn();
    const h = renderHook(({ on }) => useEscapeClose(fn, on), { initialProps: { on: false } });
    esc();
    expect(fn).not.toHaveBeenCalled();
    h.rerender({ on: true });
    esc();
    expect(fn).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it('leaves Escape to a control that already handled it', () => {
    const fn = vi.fn();
    const h = renderHook(() => useEscapeClose(fn));
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(fn).not.toHaveBeenCalled();
    h.unmount();
  });
});
