import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const wp = vi.hoisted(() => ({ setDestination: vi.fn(), addWaypoint: vi.fn() }));
vi.mock('../../api/waypoint', () => wp);
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, characterId: 101, characterName: 'Main' } }),
}));
const alts = vi.hoisted(() => [
  { charId: 2, characterId: 102, characterName: 'Scout',  online: true,  eveSystemId: 1, systemName: null, systemClass: null },
  { charId: 3, characterId: 103, characterName: 'Hauler', online: false, eveSystemId: 1, systemName: null, systemClass: null },
]);
vi.mock('../../hooks/useAccountLocations', () => ({
  useAccountLocations: () => ({ bySystem: new Map(), byChar: new Map(alts.map((a) => [a.charId, a])) }),
}));

import { SendToCharactersModal } from './SendToCharactersModal';
import { useSendToStore } from '../../store/sendToStore';

const box = (name: string) => screen.getByText(name).closest('label')!.querySelector('input')!;

describe('SendToCharactersModal', () => {
  beforeEach(() => {
    wp.setDestination.mockReset().mockResolvedValue(undefined);
    wp.addWaypoint.mockReset().mockResolvedValue(undefined);
    useSendToStore.getState().open(30000142, 'Jita');
  });

  it('starts with you and the online alts ticked, and offline ones unavailable', () => {
    render(<SendToCharactersModal />);
    expect(box('Main').checked).toBe(true);
    expect(box('Scout').checked).toBe(true);
    expect(box('Hauler').checked).toBe(false);
    expect(box('Hauler').disabled).toBe(true);
  });

  it('sends the destination to the ticked characters, then closes', async () => {
    render(<SendToCharactersModal />);
    fireEvent.click(box('Main'));                       // untick yourself
    fireEvent.click(screen.getByText('waypoint.setDestination'));
    expect(wp.setDestination).toHaveBeenCalledWith(30000142, 'Jita', [2]);
    await waitFor(() => expect(useSendToStore.getState().target).toBeNull());
  });

  it('appends a waypoint with Add Waypoint', () => {
    render(<SendToCharactersModal />);
    fireEvent.click(screen.getByText('waypoint.addWaypoint'));
    expect(wp.addWaypoint).toHaveBeenCalledWith(30000142, 'Jita', [1, 2]);
  });

  it('can’t send with nobody ticked', () => {
    render(<SendToCharactersModal />);
    fireEvent.click(box('Main'));
    fireEvent.click(box('Scout'));
    expect((screen.getByText('waypoint.setDestination') as HTMLButtonElement).disabled).toBe(true);
  });
});
