import { describe, it, expect } from 'vitest';
import { safeArg } from './logger.js';

describe('safeArg', () => {
  it('reduces an error to name and message', () => {
    expect(safeArg(new Error('boom'))).toBe('Error: boom');
  });

  it('appends the cause, with its code', () => {
    const cause = Object.assign(new Error('getaddrinfo EAI_AGAIN example.com'), { code: 'EAI_AGAIN' });
    expect(safeArg(new TypeError('fetch failed', { cause })))
      .toBe('TypeError: fetch failed (EAI_AGAIN: getaddrinfo EAI_AGAIN example.com)');
  });

  it('passes non-errors through', () => {
    expect(safeArg(42)).toBe(42);
  });
});
