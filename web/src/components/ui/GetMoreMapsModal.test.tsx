import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ api }));
vi.mock('react-i18next', () => ({
  // Echo the key plus its interpolation values, so a test can assert that the
  // right numbers reach the copy without depending on English wording.
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
    i18n: { language: 'en' },
  }),
}));

import { GetMoreMapsModal } from './GetMoreMapsModal';

const BASE = {
  used: 5, cap: 5, base: 5, donated: 0, toNext: 500_000_000,
  priceIsk: 500_000_000, perGrant: 5, enabled: true,
  corpId: 98120330, corpName: 'The 404', donations: [],
};

describe('GetMoreMapsModal', () => {
  beforeEach(() => { api.mockReset(); });

  it('names the recipient corporation the server resolved', async () => {
    api.mockResolvedValue(BASE);
    render(<GetMoreMapsModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('The 404')).toBeTruthy());
  });

  // The corp is deployment config, so a self-hoster must never be shown someone
  // else's corp name — and if the name can't be resolved, the id is still
  // enough to find it in game.
  it('falls back to the corporation id when the name cannot be resolved', async () => {
    api.mockResolvedValue({ ...BASE, corpName: null });
    render(<GetMoreMapsModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('98120330')).toBeTruthy());
  });

  it('tells the pilot how many maps they are using', async () => {
    api.mockResolvedValue({ ...BASE, used: 5, cap: 10 });
    render(<GetMoreMapsModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/getMoreMaps\.using.*"used":5.*"cap":10/)).toBeTruthy());
  });

  it('always states the delay, so nobody expects it to be instant', async () => {
    api.mockResolvedValue(BASE);
    render(<GetMoreMapsModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('getMoreMaps.timing')).toBeTruthy());
  });

  it('always warns that the donation must come from a linked character', async () => {
    api.mockResolvedValue(BASE);
    render(<GetMoreMapsModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('getMoreMaps.mustBeLinked')).toBeTruthy());
  });

  it('hides the contribution history for someone who has never donated', async () => {
    api.mockResolvedValue(BASE);
    render(<GetMoreMapsModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('getMoreMaps.timing')).toBeTruthy());
    expect(screen.queryByText(/getMoreMaps\.contributed/)).toBeNull();
  });

  it('shows the running total and what is left for the next grant', async () => {
    api.mockResolvedValue({
      ...BASE, donated: 300_000_000, toNext: 200_000_000,
      donations: [{ amount: '300000000', occurredAt: '2026-09-09T10:00:00Z' }],
    });
    render(<GetMoreMapsModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/getMoreMaps\.contributed/)).toBeTruthy());
    expect(screen.getByText(/getMoreMaps\.toNext.*200,000,000/)).toBeTruthy();
  });

  it('says so when the details cannot be loaded, rather than showing nothing', async () => {
    api.mockRejectedValue(new Error('offline'));
    render(<GetMoreMapsModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('getMoreMaps.loadFailed')).toBeTruthy());
  });
});
