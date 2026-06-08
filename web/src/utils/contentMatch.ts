import type { SystemContent, ContentFilter } from '../store/mapStore';

// Signature / anomaly types offered in the content filter (most-useful first).
// Labels come from the existing sigType.* / anomType.* i18n namespaces.
export const FILTER_SIG_TYPES = ['wormhole', 'gas', 'data', 'relic', 'combat', 'ore'] as const;
export const FILTER_ANOM_TYPES = ['combat', 'ore', 'homefront'] as const;

/** Is any filter criterion set? When false the whole map shows normally. */
export function contentFilterActive(f: ContentFilter): boolean {
  return f.sigTypes.length > 0 || f.anomTypes.length > 0 || f.nameQuery.trim() !== '';
}

/** Does a system's scanned content satisfy the filter (OR across criteria)? */
export function systemMatchesContent(c: SystemContent | undefined, f: ContentFilter): boolean {
  if (!c) return false;
  if (f.sigTypes.some((t) => c.sigTypes.includes(t))) return true;
  if (f.anomTypes.some((t) => c.anomTypes.includes(t))) return true;
  const q = f.nameQuery.trim().toLowerCase();
  if (q && c.names.some((n) => n.includes(q))) return true;
  return false;
}
