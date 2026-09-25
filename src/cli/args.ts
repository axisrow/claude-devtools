/**
 * Shared CLI plumbing for the analyze:* commands — flag-value scanning,
 * ccusage-style date bounds (--since/--until/--last N), range checks,
 * direct-run detection.
 * No dependencies; pure functions so tests import them directly.
 */

import * as fs from 'fs';
import { pathToFileURL } from 'url';

// the next token is a flag's value unless missing or itself a flag
// (--rounds --json must not swallow --json)
export function takeFlagValue(argv: string[], i: number): { value: string; next: number } {
  const hasArg = i + 1 < argv.length;
  const isValue = hasArg && !argv[i + 1].startsWith('--');
  return isValue ? { value: argv[i + 1], next: i + 2 } : { value: '', next: i + 1 };
}

// true when the calling module is the entry script. The caller passes its own
// `import.meta.url` (lexical — a helper's import.meta.url is the helper's file,
// wrong for bundled chunks shared between bins). realpath resolves the .bin
// symlinks npm installs (node_modules/.bin/x → package file), so a plain
// argv[1] string compare never fires there.
export function isDirectRun(selfUrl: string): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return selfUrl === pathToFileURL(fs.realpathSync(argv1)).href;
  } catch {
    return false; // argv[1] vanished or is unreadable — not a direct run
  }
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

// --last N → ccusage-style calendar window: local midnight of (today − N + 1),
// so N = 1 means "today". Callers must reject N < 1.
export function lastDaysSince(days: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d;
}

export function inDateRange(ts: Date, since?: Date, until?: Date): boolean {
  if (since && ts < since) return false;
  if (until && ts > until) return false;
  return true;
}
