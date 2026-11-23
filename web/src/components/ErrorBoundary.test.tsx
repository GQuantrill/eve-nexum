// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

afterEach(cleanup);

describe('ErrorBoundary', () => {
  it('shows the error with a reload instead of a blank page', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
    expect(screen.getByText(/kaboom/)).toBeTruthy();
    quiet.mockRestore();
  });

  it('renders its children when nothing breaks', () => {
    render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
    expect(screen.getByText('fine')).toBeTruthy();
  });
});
