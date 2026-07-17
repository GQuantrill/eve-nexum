/** The name to DISPLAY for a mapped system: its per-map alias when set, else the
 *  real system name. Display-only — never use this for routing, ESI, Dotlan URLs,
 *  or any name-based matching (those must use the real `name`). */
export function systemDisplayName(sys: { alias?: string | null; name: string }): string {
  const a = sys.alias?.trim();
  return a || sys.name;
}
