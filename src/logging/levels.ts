export const ALLOWED_LOG_LEVELS = [
  "silent",
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
] as const;

export type LogLevel = (typeof ALLOWED_LOG_LEVELS)[number];

export function tryParseLogLevel(level?: string): LogLevel | undefined {
  if (typeof level !== "string") {
    return undefined;
  }
  const candidate = level.trim();
  return ALLOWED_LOG_LEVELS.includes(candidate as LogLevel) ? (candidate as LogLevel) : undefined;
}

export function normalizeLogLevel(level?: string, fallback: LogLevel = "info") {
  return tryParseLogLevel(level) ?? fallback;
}

/**
 * Verbosity rank: higher means "more is allowed through". This is the internal
 * scale used by the level comparisons (`msg <= configured` means "log it"), and
 * it is NOT the number tslog wants — see logLevelToTslogMinLevel.
 */
export function levelToMinLevel(level: LogLevel): number {
  const map: Record<LogLevel, number> = {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
    silent: Number.POSITIVE_INFINITY,
  };
  return map[level];
}

/**
 * The value to hand to tslog as `minLevel`. tslog ranks levels by severity
 * (silly=0, trace=1, debug=2, info=3, warn=4, error=5, fatal=6) and drops any
 * record whose rank is below `minLevel`, so `minLevel` is a floor on severity:
 * a configured level of "error" must yield 5, not 1.
 */
export function logLevelToTslogMinLevel(level: LogLevel): number {
  const map: Record<LogLevel, number> = {
    trace: 1,
    debug: 2,
    info: 3,
    warn: 4,
    error: 5,
    fatal: 6,
    silent: Number.POSITIVE_INFINITY,
  };
  return map[level];
}
