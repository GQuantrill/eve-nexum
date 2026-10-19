import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
const useOrgIds = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/useOrgLogos', () => ({ useOrgIds }));

import { OrgLogos } from './OrgLogos';

describe('OrgLogos', () => {
  it('renders nothing on an open deployment', () => {
    useOrgIds.mockReturnValue({ corpIds: [], allianceIds: [] });
    const { container } = render(<OrgLogos className="x" size={26} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows the alliance logo before the corp logo', () => {
    useOrgIds.mockReturnValue({ corpIds: [98000001], allianceIds: [99000001] });
    const { container } = render(<OrgLogos className="x" size={26} />);
    const srcs = [...container.querySelectorAll('img')].map((i) => i.getAttribute('src'));
    expect(srcs).toEqual([
      'https://images.evetech.net/alliances/99000001/logo?size=64',
      'https://images.evetech.net/corporations/98000001/logo?size=64',
    ]);
  });
});
