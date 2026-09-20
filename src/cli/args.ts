/**
 * Shared CLI plumbing for the analyze:* commands — flag-value scanning,
 * ccusage-style date bounds (--since/--until/--last N), range checks.
 * No dependencies; pure functions so tests import them directly.
 */

// the next token is a flag's value unless missing or itself a flag
// (--rounds --json must not swallow --json)
export function takeFlagValue(argv: string[], i: number): { value: string; next: number } {
  const hasArg = i + 1 < argv.length;
  const isValue = hasArg && !argv[i + 1].startsWith('--');
  return isValue ? { value: argv[i + 1], next: i + 2 } : { value: '', next: i + 1 };
}

export const wantsHelp = (argv: string[]): boolean =>
  argv.includes('--help') || argv.includes('-h');

// `YYYY-MM-DD` or `YYYYMMDD` → local start (or end) of that day; null when malformed
export function parseDayBound(s: string, endOfDay: boolean): Date | null {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

// --last N → start of the rolling window, N*24h back
export function lastDaysSince(days: number): Date {
  return new Date(Date.now() - days * 86400000);
}

export function inDateRange(ts: Date, since?: Date, until?: Date): boolean {
  if (since && ts < since) return false;
  if (until && ts > until) return false;
  return true;
}
