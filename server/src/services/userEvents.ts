import type { Response } from 'express';

// Events addressed to a character rather than a map: settings changes, which
// have to reach every open tab of every linked character. Delivered over the
// map event streams those tabs already hold open (see mapStream.ts), so a tab
// with no map open misses them and picks the settings up on its next load. One
// process only, like mapEvents.ts.
const subscribers = new Map<number, Set<Response>>();

export function subscribeUser(userId: number, res: Response): () => void {
  let set = subscribers.get(userId);
  if (!set) { set = new Set(); subscribers.set(userId, set); }
  set.add(res);
  return () => {
    const s = subscribers.get(userId);
    if (!s) return;
    s.delete(res);
    if (s.size === 0) subscribers.delete(userId);
  };
}

export interface UserEvent {
  type: string;
  actor?: string | null; // originating client id, for echo suppression
  [key: string]: unknown;
}

export function publishToUsers(userIds: number[], event: UserEvent): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const id of userIds) {
    for (const res of subscribers.get(id) ?? []) {
      try { res.write(frame); } catch { /* dead connection; its close handler cleans up */ }
    }
  }
}
