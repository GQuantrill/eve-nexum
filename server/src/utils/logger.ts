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
// fragments, tokens, etc.). Non-Error args pass through untouched. A wrapped
// cause is appended the same way: fetch's bare "fetch failed" only says what
// went wrong (DNS, refused, reset, connect timeout) in its cause.
export function safeArg(a: unknown): unknown {
  if (!(a instanceof Error)) return a;
  const c = a.cause;
  if (!(c instanceof Error)) return `${a.name}: ${a.message}`;
  const code = (c as Error & { code?: unknown }).code;
  return `${a.name}: ${a.message} (${typeof code === 'string' ? `${code}: ` : ''}${c.message})`;
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
