const SKIP_KEY = 'nexum.skipDeleteConfirm';

/** Has the user ticked "don't ask again" on destructive confirmations? */
export function shouldSkipConfirm(): boolean {
  return localStorage.getItem(SKIP_KEY) === 'true';
}

export function setSkipConfirm(skip: boolean): void {
  if (skip) localStorage.setItem(SKIP_KEY, 'true');
  else localStorage.removeItem(SKIP_KEY);
}
