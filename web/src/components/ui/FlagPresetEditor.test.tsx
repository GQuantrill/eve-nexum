import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
    i18n: { language: 'en' },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));
vi.mock('../DynamicIcon', () => ({ DynamicIcon: ({ name }: { name: string }) => <i data-icon={name} /> }));
vi.mock('./IconPickerDialog', () => ({ IconPickerDialog: () => <div>icon-picker</div> }));
vi.mock('uuid', () => ({ v4: () => 'generated-id' }));

import { FlagPresetEditor } from './FlagPresetEditor';
import { MAX_FLAG_PRESETS } from '../../hooks/useFlagPresets';

const P = (id: string) => ({ id, name: `Preset ${id}`, icon: 'Skull', color: '#e05a5a' });

describe('FlagPresetEditor', () => {
  it('adds a preset through the callback rather than owning state', () => {
    const onChange = vi.fn();
    render(<FlagPresetEditor items={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText(/flagPresets\.add/));
    expect(onChange).toHaveBeenCalledWith([
      { id: 'generated-id', name: 'flagPresets.newItem', icon: 'Tag', color: '#f0a030' },
    ]);
  });

  it('stops adding at the cap', () => {
    const onChange = vi.fn();
    const full = Array.from({ length: MAX_FLAG_PRESETS }, (_, i) => P(String(i)));
    render(<FlagPresetEditor items={full} onChange={onChange} />);
    const add = screen.getByText(/flagPresets\.add/).closest('button')!;
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('edits a name in place, leaving the other entries alone', () => {
    const onChange = vi.fn();
    render(<FlagPresetEditor items={[P('a'), P('b')]} onChange={onChange} />);
    const inputs = screen.getAllByDisplayValue(/Preset/);
    fireEvent.change(inputs[0], { target: { value: 'DO NOT ROLL' } });
    expect(onChange).toHaveBeenCalledWith([
      { ...P('a'), name: 'DO NOT ROLL' },
      P('b'),
    ]);
  });

  it('removes only the row asked for', () => {
    const onChange = vi.fn();
    render(<FlagPresetEditor items={[P('a'), P('b')]} onChange={onChange} />);
    fireEvent.click(screen.getAllByLabelText('flagPresets.remove')[0]);
    expect(onChange).toHaveBeenCalledWith([P('b')]);
  });

  it('locks every control while a save is in flight', () => {
    const onChange = vi.fn();
    const { container } = render(<FlagPresetEditor items={[P('a')]} onChange={onChange} disabled />);
    // Control: the row rendered, so the assertion below is about `disabled`.
    expect(screen.getAllByDisplayValue(/Preset/)).toHaveLength(1);
    const enabled = [...container.querySelectorAll('button, input')].filter((e) => !(e as HTMLButtonElement).disabled);
    expect(enabled).toHaveLength(0);
  });
});
