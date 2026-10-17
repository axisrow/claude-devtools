/**
 * bell-stats CLI — per-date bell fire counts by type (source).
 *
 * Reads two independent sources and never merges them (they overlap on
 * turn_budget: the app bell caps at 100 recent entries, the hook log keeps
 * the full deny history):
 *   1. ~/.claude/claude-devtools-notifications.json — the live bell store
 *   2. ~/.claude/claude-devtools-turnbudget.log     — hook deny history,
 *      reported as its own source `turn_budget_hook`
 *
 * Usage: bell-stats [--type SOURCE] [--since DATE] [--until DATE] [--json]
 * Dates are local (YYYY-MM-DD or YYYYMMDD), bounds inclusive.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { inDateRange, isDirectRun, parseDayBound, takeFlagValue, wantsHelp } from './args';

// ===========================================================================
// Pure core (exported for tests)
// ===========================================================================

export interface BellEntry {
  /** Unix epoch ms */
  timestamp: number;
  /** Trigger source, e.g. `loop`, `turn_budget`, `turn_budget_hook` */
  source: string;
}

export interface BellStatsRow {
  date: string;
  source: string;
  count: number;
}

export interface BellStats {
  rows: BellStatsRow[];
  total: number;
}

export interface BellStatsOptions {
  type?: string;
  since?: Date;
  until?: Date;
}

/** One hook-log line -> entry, denies only; null for anything else. */
export function parseTurnbudgetLogLine(line: string): BellEntry | null {
  const m = /^(\S+) kind=deny /.exec(line);
  if (!m) return null;
  const timestamp = Date.parse(m[1]);
  if (!Number.isFinite(timestamp)) return null;
  return { timestamp, source: 'turn_budget_hook' };
}

function localDateKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Entries -> per-date x source counts, date asc then source asc. */
export function buildBellStats(entries: BellEntry[], opts: BellStatsOptions = {}): BellStats {
  const counts = new Map<string, Map<string, number>>();
  let total = 0;
  for (const e of entries) {
    if (opts.type !== undefined && e.source !== opts.type) continue;
    const d = new Date(e.timestamp);
    if (!inDateRange(d, opts.since, opts.until)) continue;
    const date = localDateKey(e.timestamp);
    const bySource = counts.get(date) ?? new Map<string, number>();
    bySource.set(e.source, (bySource.get(e.source) ?? 0) + 1);
    counts.set(date, bySource);
    total++;
  }
  const rows: BellStatsRow[] = [];
  for (const date of [...counts.keys()].sort((a, b) => a.localeCompare(b))) {
    for (const [source, count] of [...counts.get(date)!.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      rows.push({ date, source, count });
    }
  }
  return { rows, total };
}

// ===========================================================================
// CLI
// ===========================================================================

const NOTIFICATIONS_PATH = path.join(os.homedir(), '.claude', 'claude-devtools-notifications.json');
const TURNBUDGET_LOG_PATH = path.join(os.homedir(), '.claude', 'claude-devtools-turnbudget.log');

function readBellEntries(): BellEntry[] {
  const out: BellEntry[] = [];
  // fail-open: a missing/corrupt source shrinks the report, never breaks it
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8'));
    if (Array.isArray(raw)) {
      for (const n of raw) {
        const timestamp = Number((n as { timestamp?: unknown }).timestamp);
        const source = (n as { source?: unknown }).source;
        if (Number.isFinite(timestamp) && typeof source === 'string') {
          out.push({ timestamp, source });
        }
      }
    }
  } catch {
    // no bell store — log history alone still tells the story
  }
  try {
    for (const line of fs.readFileSync(TURNBUDGET_LOG_PATH, 'utf8').split('\n')) {
      const e = parseTurnbudgetLogLine(line);
      if (e) out.push(e);
    }
  } catch {
    // no hook log — fine
  }
  return out;
}

function parseDateFlag(argv: string[], flag: string, endOfDay: boolean): Date | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const { value } = takeFlagValue(argv, i);
  const d = parseDayBound(value, endOfDay);
  if (!d) {
    console.error(`bad ${flag} value: ${value} (expected YYYY-MM-DD)`);
    process.exit(1);
  }
  return d;
}

function printTable(stats: BellStats, sources: string[]): void {
  const cols = ['date', ...sources, 'total'];
  const cells: string[][] = [];
  const byDate = new Map<string, Map<string, number>>();
  for (const r of stats.rows) {
    const m = byDate.get(r.date) ?? new Map<string, number>();
    m.set(r.source, r.count);
    byDate.set(r.date, m);
  }
  for (const [date, m] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const row = sources.map((s) => String(m.get(s) ?? 0));
    row.push(String(row.reduce((sum, v) => sum + Number(v), 0)));
    cells.push([date, ...row]);
  }
  const width = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]?.length ?? 0)));
  const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(width[i])).join('  ');
  console.log(line(cols));
  for (const row of cells) console.log(line(row));
  console.log(line(['total', ...sources.map(() => ''), String(stats.total)]));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(
      'Usage: bell-stats [--type SOURCE] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]\n' +
        'Sources: live bell (notifications.json) + hook deny history (turnbudget.log\n' +
        'as `turn_budget_hook`). Pass --type to filter one source.'
    );
    return;
  }
  const typeIdx = argv.indexOf('--type');
  const type = typeIdx === -1 ? undefined : takeFlagValue(argv, typeIdx).value || undefined;
  const since = parseDateFlag(argv, '--since', false);
  const until = parseDateFlag(argv, '--until', true);

  const stats = buildBellStats(readBellEntries(), { type, since, until });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  const sources = [...new Set(stats.rows.map((r) => r.source))].sort((a, b) => a.localeCompare(b));
  if (stats.total === 0) {
    console.log('no bell firings in range');
    return;
  }
  printTable(stats, sources);
}

if (isDirectRun(import.meta.url)) {
  void main();
}
