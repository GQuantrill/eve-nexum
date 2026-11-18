// Shared by the first-run prompts so they open one at a time.

export const PROXIMITY_ASKED_KEY = 'nexum.proximityOptInAsked';

/** Whether the threat-alert prompt (ProximityOptInModal) still has to be shown.
 *  Other first-run prompts wait for it, so two never open at once. */
export function proximityPromptPending(): boolean {
  try {
    return typeof Notification !== 'undefined'
      && Notification.permission === 'default'
      && !localStorage.getItem(PROXIMITY_ASKED_KEY);
  } catch {
    return false;
  }
}
