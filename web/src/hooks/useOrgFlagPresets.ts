import { createStaticResource } from './createStaticResource';
import type { FlagPreset } from '../types';

// The corp/alliance's standardised flag presets. Loaded once per page: an org's
// agreed vocabulary changes about as often as its Discord webhook, so polling
// it would be a request per interval for an answer that is almost never new.
// An admin editing the list sees their own change locally; everyone else picks
// it up on their next load, which is soon enough for a naming convention.
const { useResource } = createStaticResource<FlagPreset[]>('/api/flag-presets', []);
export const useOrgFlagPresets = useResource;
