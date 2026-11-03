import { describe, it, expect } from 'vitest';
import { connectionsToRevive } from './useReviveBackedConnections';
import type { MapConnection, MapSystem } from '../types';
import type { WhSig } from '../utils/undivedWormholes';

const sys = (id: string, name: string, systemClass = 'C5') =>
  ({ id, name, systemClass }) as unknown as MapSystem;
const conn = (id: string, sourceId: string, targetId: string, extra: Partial<MapConnection> = {}) =>
  ({
    id, sourceId, targetId, connectionType: 'standard', broken: true, type: null, massUsed: 0,
    sourceSignatureId: null, targetSignatureId: null, ...extra,
  }) as unknown as MapConnection;
const sig = (id: string, whType: string, leadsTo: string): WhSig => ({ id, sigId: id, whType, leadsTo });
const types = { H296: { dest: 'c5' } };

// Home (C5) with a live H296 -> C5 to J1, and a dead link to J2 (also C5).
const systems = [sys('home', 'J0'), sys('j1', 'J1'), sys('j2', 'J2')];

describe('connectionsToRevive', () => {
  it('revives a broken link scanned on both ends', () => {
    const sigs = { home: [sig('s1', 'H296', '')], j2: [sig('s2', 'K162', 'C5')] };
    expect(connectionsToRevive(systems, [conn('c2', 'home', 'j2')], sigs, types)).toEqual(['c2']);
  });

  it('does not count a sig pinned to another system', () => {
    const sigs = { home: [sig('s1', 'H296', 'J1')], j2: [sig('s2', 'K162', 'J0')] };
    expect(connectionsToRevive(systems, [conn('c2', 'home', 'j2')], sigs, types)).toEqual([]);
  });

  it('does not count a sig linked to another connection', () => {
    const sigs = { home: [sig('s1', 'H296', '')], j2: [sig('s2', 'K162', 'J0')] };
    const live = conn('c1', 'home', 'j1', { broken: false, sourceSignatureId: 's1' });
    expect(connectionsToRevive(systems, [live, conn('c2', 'home', 'j2')], sigs, types)).toEqual([]);
  });

  it('counts sigs linked to this connection', () => {
    const sigs = { home: [sig('s1', 'H296', 'J1')], j2: [sig('s2', 'K162', 'J0')] };
    const c = conn('c2', 'home', 'j2', { sourceSignatureId: 's1', targetSignatureId: 's2' });
    expect(connectionsToRevive(systems, [c], sigs, types)).toEqual(['c2']);
  });
});
