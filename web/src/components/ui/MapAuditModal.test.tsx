import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ api }));
vi.mock('react-i18next', () => ({
  // Echo the key plus the subject, so the test checks which sentence and what
  // it's about without depending on English wording.
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v && 'subject' in v ? `${k}(${v.subject})` : k),
    i18n: { language: 'en' },
  }),
}));

import { MapAuditModal } from './MapAuditModal';

const entry = (id: string, over: Record<string, unknown> = {}) => ({
  id, createdAt: new Date().toISOString(), action: 'system.add', subject: `J${id}`, details: null,
  characterId: 90000001, characterName: 'Scout One', viaApi: false, ...over,
});

describe('MapAuditModal', () => {
  beforeEach(() => { api.mockReset(); });

  it('lists who did what, with changed fields and recorded values', async () => {
    api.mockResolvedValue({ entries: [
      entry('1', { action: 'connection.update', subject: 'A ↔ B', details: { fields: ['massStatus', 'flagNote'], values: { massStatus: 'critical' } } }),
      entry('2', { viaApi: true }),
    ], more: false, retentionDays: 30 });
    render(<MapAuditModal mapId="m1" mapName="Home" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('audit.action.connection.update(A ↔ B)')).toBeTruthy());
    expect(screen.getByText('audit.field.massStatus: critical · audit.field.flagNote')).toBeTruthy();
    expect(screen.getAllByText('Scout One')).toHaveLength(2);
    expect(screen.getByText('audit.viaApi')).toBeTruthy();
    expect(api).toHaveBeenCalledWith('/api/maps/m1/audit');
  });

  it('loads older entries after the last one shown', async () => {
    api.mockResolvedValueOnce({ entries: [entry('9'), entry('8')], more: true, retentionDays: 30 });
    api.mockResolvedValueOnce({ entries: [entry('7')], more: false, retentionDays: 30 });
    render(<MapAuditModal mapId="m1" mapName="Home" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByText('audit.loadMore'));
    await waitFor(() => expect(screen.getByText('audit.action.system.add(J7)')).toBeTruthy());
    expect(api).toHaveBeenLastCalledWith('/api/maps/m1/audit?before=8');
    expect(screen.queryByText('audit.loadMore')).toBeNull();
  });

  it('says so when nothing has been recorded', async () => {
    api.mockResolvedValue({ entries: [], more: false, retentionDays: 30 });
    render(<MapAuditModal mapId="m1" mapName="Home" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('audit.empty')).toBeTruthy());
  });
});
