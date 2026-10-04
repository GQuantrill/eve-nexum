import { describe, it, expect } from 'vitest';
import { parseDefaultRole, DEFAULT_ROLE_CHOICES } from './config.js';

// DEFAULT_USER_ROLE=contributor was silently admitting everyone as 'readonly':
// 'contributor' is a valid role everywhere else in the app (the invite flow
// takes it, the access_grants CHECK lists it, admins assign it by hand) but was
// missing from the accepted values here, so it fell through to the safe default
// with only a boot-time warning an operator was unlikely to see.
describe('DEFAULT_USER_ROLE parsing', () => {
  it('accepts every non-admin tier, contributor included', () => {
    expect(parseDefaultRole('contributor')).toBe('contributor');
    expect(parseDefaultRole('readonly')).toBe('readonly');
    expect(parseDefaultRole('edit')).toBe('edit');
    expect(parseDefaultRole('full')).toBe('full');
  });

  it('tolerates the casing and padding a hand-edited .env tends to carry', () => {
    expect(parseDefaultRole('  Contributor  ')).toBe('contributor');
    expect(parseDefaultRole('EDIT')).toBe('edit');
  });

  it('never mints an admin, whatever the env says', () => {
    // The whole reason this allowlist exists: a deployment must not be able to
    // make every arriving character an admin by editing one line.
    expect(parseDefaultRole('admin')).toBe('readonly');
    expect(parseDefaultRole('alliance_admin')).toBe('readonly');
  });

  it('falls back safely on junk, empty and missing values', () => {
    for (const v of [undefined, '', '   ', 'editor', 'contrib', 'true', 'null']) {
      expect(parseDefaultRole(v)).toBe('readonly');
    }
  });

  it('offers exactly the non-admin tiers and nothing more', () => {
    // Guards the list itself: adding 'admin' here would be a silent privilege
    // escalation for every deployment.
    expect([...DEFAULT_ROLE_CHOICES].sort()).toEqual(['contributor', 'edit', 'full', 'readonly']);
  });
});
