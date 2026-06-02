// Tiny prefixed logger so each module emits structured-ish log lines without
// pulling in a logging dependency. Switch to pino/winston later by replacing
// the implementations here.

type Level = 'info' | 'warn' | 'error';

export interface Logger {
  info:  (msg: string, ...rest: unknown[]) => void;
  warn:  (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
}

// Reduce Error args to "Name: message" so log lines never carry full stack
// traces or other internal error properties (which can include query
// fragments, tokens, etc.). Non-Error args pass through untouched.
function safeArg(a: unknown): unknown {
  return a instanceof Error ? `${a.name}: ${a.message}` : a;
}

function emit(level: Level, prefix: string, msg: string, rest: unknown[]) {
  const stream = level === 'error' ? console.error
              : level === 'warn'  ? console.warn
              : console.log;
  stream(`[${prefix}] ${msg}`, ...rest.map(safeArg));
}

export function createLogger(prefix: string): Logger {
  return {
    info:  (msg, ...rest) => emit('info',  prefix, msg, rest),
    warn:  (msg, ...rest) => emit('warn',  prefix, msg, rest),
    error: (msg, ...rest) => emit('error', prefix, msg, rest),
  };
}
