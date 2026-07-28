// CCP's image server. Centralizes the URL shape so call sites don't hand-build
// `https://images.evetech.net/...` strings (they were duplicated ~14 times).
const BASE = 'https://images.evetech.net';

export const charPortrait = (id: number, size = 64) => `${BASE}/characters/${id}/portrait?size=${size}`;
export const corpLogo     = (id: number, size = 64) => `${BASE}/corporations/${id}/logo?size=${size}`;
export const allianceLogo = (id: number, size = 64) => `${BASE}/alliances/${id}/logo?size=${size}`;
export const typeIcon     = (id: number, size = 64) => `${BASE}/types/${id}/icon?size=${size}`;
export const typeRender   = (id: number, size = 64) => `${BASE}/types/${id}/render?size=${size}`;
