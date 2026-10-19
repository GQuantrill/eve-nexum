import { createStaticResource } from './createStaticResource';

// The corps / alliances this deployment is run for (CORP_ID / ALLIANCE_ID on
// the server). Empty on an open deployment. Public, so the landing page can
// read it before login; static for the life of the page.
export interface OrgIds { corpIds: number[]; allianceIds: number[] }

const EMPTY: OrgIds = { corpIds: [], allianceIds: [] };
const { useResource } = createStaticResource<OrgIds>('/auth/org', EMPTY);

export const useOrgIds = useResource;
