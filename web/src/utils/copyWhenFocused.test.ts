import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyWhenFocused } from './copyWhenFocused';

describe('copyWhenFocused', () => {
  let writeText: ReturnType<typeof vi.fn>;
  let focused: boolean;

  beforeEach(() => {
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    focused = true;
    vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('copies straight away when the page has focus', async () => {
    expect(await copyWhenFocused('ABC-123 C3 M')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('ABC-123 C3 M');
  });

  it('waits for the pilot to click back in when the game has focus', async () => {
    focused = false;
    const done = copyWhenFocused('ABC-123 C3 M');
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    expect(await done).toBe(true);
    expect(writeText).toHaveBeenCalledWith('ABC-123 C3 M');
  });

  it('keeps only the latest waiting text', async () => {
    focused = false;
    const first = copyWhenFocused('first');
    const second = copyWhenFocused('second');
    expect(await first).toBe(false);
    window.dispatchEvent(new Event('focus'));
    expect(await second).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('second');
  });

  it('gives up if the pilot comes back much later', async () => {
    vi.useFakeTimers();
    focused = false;
    const done = copyWhenFocused('stale');
    vi.advanceTimersByTime(6 * 60_000);
    window.dispatchEvent(new Event('focus'));
    expect(await done).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports a refused write', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    expect(await copyWhenFocused('x')).toBe(false);
  });
});
