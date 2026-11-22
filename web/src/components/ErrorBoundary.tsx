import { Component, type ErrorInfo, type ReactNode } from 'react';
import i18n from 'i18next';

// The last line of defence: an error while rendering used to unmount the whole
// app and leave a blank window. In a browser F5 gets you out; the desktop app
// has no reload, so pilots had to restart it. Now the error is shown, with a
// reload and the details to copy into a bug report.

interface State { error: Error | null; stack: string }

type ScreenKey = 'errorScreen.title' | 'errorScreen.hint' | 'errorScreen.reload' | 'errorScreen.copy';

// English if the translations themselves are what broke.
const tr = (key: ScreenKey, fallback: string): string => {
  try {
    if (!i18n.isInitialized) return fallback;
    const s: unknown = i18n.t(key);
    return typeof s === 'string' && s && s !== key ? s : fallback;
  } catch { return fallback; }
};

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? '' });
    console.error('[nexum] render error', error, info.componentStack);
  }

  private details(): string {
    const { error, stack } = this.state;
    return [
      `${error?.name ?? 'Error'}: ${error?.message ?? ''}`,
      `URL: ${window.location.pathname}`,
      `Agent: ${navigator.userAgent}`,
      '',
      error?.stack ?? '',
      stack.trim(),
    ].join('\n');
  }

  private copy = () => {
    void navigator.clipboard?.writeText(this.details()).catch(() => { /* nothing to do */ });
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="lock-screen" role="alert">
        <div className="lock-screen__card error-screen__card">
          <h1 className="lock-screen__title">{tr('errorScreen.title', 'Something went wrong')}</h1>
          <p className="lock-screen__hint">
            {tr('errorScreen.hint', 'Nexum hit an error and stopped. Reload to carry on. To report it, copy the details and send them to us.')}
          </p>
          <button type="button" className="lock-screen__resume" onClick={() => window.location.reload()}>
            {tr('errorScreen.reload', 'Reload')}
          </button>
          <button type="button" className="lock-screen__logout" onClick={this.copy}>
            {tr('errorScreen.copy', 'Copy error details')}
          </button>
          <pre className="error-screen__details">{this.details()}</pre>
        </div>
      </div>
    );
  }
}
