// Tiny prefixed logger — mirrors server/src/utils/logger.ts. Keeping a thin
// abstraction here makes it cheap to route logs through a remote sink later
// (sentry, etc) without sweeping every call site.

type Level = 'info' | 'warn' | 'error';

export interface Logger {
  info:  (msg: string, ...rest: unknown[]) => void;
  warn:  (msg: string, ...rest: unknown[]) => void;
  error: (msg: string, ...rest: unknown[]) => void;
}

function emit(level: Level, prefix: string, msg: string, rest: unknown[]) {
  const stream = level === 'error' ? console.error
              : level === 'warn'  ? console.warn
              : console.log;
  stream(`[${prefix}] ${msg}`, ...rest);
}

export function createLogger(prefix: string): Logger {
  return {
    info:  (msg, ...rest) => emit('info',  prefix, msg, rest),
    warn:  (msg, ...rest) => emit('warn',  prefix, msg, rest),
    error: (msg, ...rest) => emit('error', prefix, msg, rest),
  };
}
