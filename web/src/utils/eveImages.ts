// CCP's image server. Centralizes the URL shape so call sites don't hand-build
// `https://images.evetech.net/...` strings (they were duplicated ~14 times).
const BASE = 'https://images.evetech.net';

// EVE ids are bigint columns, and node-postgres hands bigints back as STRINGS
// to avoid precision loss (no int8 parser is registered). So an id reaching the
// client may be either, depending on whether it came from a query or a session.
// These only interpolate it, so both are fine — the type just says so now
// instead of claiming a number and being wrong half the time.
type EveId = number | string;

export const charPortrait = (id: EveId, size = 64) => `${BASE}/characters/${id}/portrait?size=${size}`;
export const corpLogo     = (id: EveId, size = 64) => `${BASE}/corporations/${id}/logo?size=${size}`;
export const allianceLogo = (id: EveId, size = 64) => `${BASE}/alliances/${id}/logo?size=${size}`;
export const typeIcon     = (id: EveId, size = 64) => `${BASE}/types/${id}/icon?size=${size}`;
export const typeRender   = (id: EveId, size = 64) => `${BASE}/types/${id}/render?size=${size}`;
