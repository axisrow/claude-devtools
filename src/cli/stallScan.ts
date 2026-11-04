/**
 * stall-scan CLI — stalled-stream ("провис") detection across ~/.claude/projects.
 *
 * A stall is a gap >= --min-gap between consecutive transcript line timestamps
 * while a turn was in flight. Reference incident (2026-11-04): a reviewer sat
 * 3.5h in "Infusing" — zero transcript writes — then resumed and paid a
 * full-price cache miss (~190k input, cache TTL expired during the wait).
 *
 * Detection deliberately does NOT use api-request lines: the harness writes
 * them lazily with backdated timestamps (observed in the incident file), so
 * the only trustworthy signal is the delta between consecutive line
 * timestamps in append order (high-water mark guards against backdated lines).
 * Subagent transcripts are scanned as independent files — the incident wedge
 * lived in a background-task transcript, not the main one.
 *
 * Outcomes:
 *   truncated              gap never closed; file left hanging (last line is
 *                          not a system entry) — died mid-flight or still hung
 *   api-error              "API Error: ..." synthetic line right after the gap
 *   resumed-user           first post-gap line is a real user message
 *                          (legit "user went away" pause)
 *   resumed-continuation   anything else (steer / queue-op / tool result)
 * For resumed incidents the first post-gap assistant usage with
 * input/inputSide >= 0.5 is reported as cacheMissTokens (full-price re-read).
 *
 * Usage:
 *   stall-scan [--project <dir|encoded>] [flags]
 * Flags:
 *   --project <dir|encoded>  scan one project instead of all
 *   --min-gap MINUTES        minimum gap to flag (default 10)
 *   --since / --until DATE   flag incidents whose gap started in the window
 *   --last N                 same, last N calendar days
 *   --sort FIELD             minutes | start | project (default minutes)
 *   --limit N                incidents shown (default 50)
 *   --json                   machine-readable output
 */

import { extractSessionId, getProjectsBasePath } from '@main/utils/pathDecoder';
import { inputSideTokens, isRealUserLine } from '@shared/turnAccounting';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { dur, pad, padL, resolveProjectDir, short } from './analyzeSession';
import {
  inDateRange,
  isDirectRun,
  lastDaysSince,
  parseDayBound,
  takeFlagValue,
  wantsHelp,
} from './args';
import { mapWithConcurrency } from './sessionInventory';
import { listSessionFiles, parseApiErrorKey, percentiles } from './toolStats';

// =============================================================================
// Types
// =============================================================================

export type StallOutcome = 'truncated' | 'api-error' | 'resumed-user' | 'resumed-continuation';

export interface StallIncident {
  projectId: string;
  sessionId: string;
  fileKind: 'main' | 'subagent';
  /** model of the last assistant line before the gap */
  model?: string;
  gapStartMs: number;
  /** null for truncated — the gap never closed */
  gapEndMs: number | null;
  /** floor minutes of the closed gap; 0 for truncated */
  minutes: number;
  outcome: StallOutcome;
  /** normalized "API Error:" text, for api-error outcome */
  errorKey?: string;
  /** full-price input of the first post-gap assistant usage (cache expired) */
  cacheMissTokens: number;
}

interface ScanLine {
  timestamp?: string;
  type?: string;
  isMeta?: boolean;
  cwd?: string;
  message?: {
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

export interface StallScanOpts {
  projectArg?: string;
  minGapMinutes: number;
  since?: Date;
  until?: Date;
  sort: 'minutes' | 'start' | 'project';
  limit: number;
  json: boolean;
  error?: string;
}

export interface StallAggregate {
  total: number;
  /** distinct project/session pairs */
  sessions: number;
  byOutcome: Record<StallOutcome, number>;
  byModel: Record<string, number>;
  byProject: Record<string, number>;
  byDay: Record<string, number>;
  /** Σ minutes of closed gaps */
  totalStallMinutes: number;
  totalCacheMissTokens: number;
  /** minutes of each closed gap — percentile/threshold source */
  durationsMinutes: number[];
  /** minutes of closed gaps with the wedge profile (cont-resume + api-error) */
  wedgeDurationsMinutes: number[];
  /** incidents whose gap never closed (no duration) */
  unclosed: number;
}

interface ScanOpts {
  minGapMs: number;
  fileKind: 'main' | 'subagent';
  scanBase: string;
  sinceMs?: number;
  untilMs?: number;
  /** injectable for tests: "now" used by the truncated-at-EOF check */
  nowMs?: number;
}

// =============================================================================
// Per-file scan (streaming, single pass)
// =============================================================================

const textOf = (e: ScanLine): string => {
  const c = e.message?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        b && typeof b === 'object' && (b as { text?: unknown }).text
          ? String((b as { text: unknown }).text)
          : ''
      )
      .join('');
  }
  return '';
};

export async function scanFileForStalls(
  filePath: string,
  opts: ScanOpts
): Promise<StallIncident[]> {
  const incidents: StallIncident[] = [];
  const rel = path.relative(path.resolve(opts.scanBase), path.resolve(filePath));
  const segs = rel.split(path.sep);
  const projectId = segs[0] ?? '';
  const isMain = opts.fileKind === 'main';
  const sessionId = isMain ? extractSessionId(segs[1] ?? '') : (segs[1] ?? '');
  const inRange = (startMs: number): boolean =>
    inDateRange(
      new Date(startMs),
      opts.sinceMs ? new Date(opts.sinceMs) : undefined,
      opts.untilMs ? new Date(opts.untilMs) : undefined
    );

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let lastTs: number | null = null; // high-water mark — backdated lines must not fake gaps
  let lastType: string | undefined;
  let lastModel: string | undefined;
  let lastWasApiError = false;
  // incident whose gap closed and is being classified from post-gap lines
  let open: StallIncident | null = null;
  let openPostLines = 0; // post-gap lines seen for the open incident

  const close = (): void => {
    if (!open) return;
    open.minutes = Math.floor((open.gapEndMs! - open.gapStartMs) / 60000);
    incidents.push(open);
    open = null;
  };

  for await (const line of rl) {
    if (line === '') continue;
    let e: ScanLine;
    try {
      e = JSON.parse(line) as ScanLine;
    } catch {
      continue;
    }
    if (!e.timestamp) continue;
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    const syntheticKey =
      e.type === 'assistant' && e.message?.model === '<synthetic>'
        ? parseApiErrorKey(textOf(e))
        : null;

    if (lastTs !== null && ts - lastTs >= opts.minGapMs && inRange(lastTs)) {
      close();
      open = {
        projectId,
        sessionId,
        fileKind: opts.fileKind,
        model: lastModel,
        gapStartMs: lastTs,
        gapEndMs: ts,
        minutes: 0,
        outcome: 'resumed-continuation',
        cacheMissTokens: 0,
      };
      openPostLines = 0;
    }

    if (open) {
      // classify from the first post-gap line; api-error may land a few lines later
      if (openPostLines < 5) {
        openPostLines++;
        if (openPostLines === 1 && isRealUserLine(e)) open.outcome = 'resumed-user';
        if (syntheticKey !== null) {
          open.outcome = 'api-error';
          open.errorKey = syntheticKey;
        }
      }
      const u = e.message?.usage;
      if (open.cacheMissTokens === 0 && e.type === 'assistant' && u) {
        const input = u.input_tokens ?? 0;
        const side = inputSideTokens(u);
        if (side > 0 && input / side >= 0.5) open.cacheMissTokens = input;
      }
    }

    lastWasApiError = syntheticKey !== null;
    if (e.type === 'assistant' && e.message?.model && e.message.model !== '<synthetic>') {
      lastModel = e.message.model;
    }
    lastTs = lastTs === null ? ts : Math.max(lastTs, ts);
    lastType = e.type;
  }
  close();

  // gap that never closed: file left hanging after a non-system line. A trailing
  // synthetic API-error line is the known "died on API error" ending — that's
  // already captured by the api-error outcome, don't double-report it.
  const now = opts.nowMs ?? Date.now();
  if (
    open === null &&
    lastTs !== null &&
    lastType !== 'system' &&
    !lastWasApiError &&
    now - lastTs >= opts.minGapMs &&
    inRange(lastTs)
  ) {
    incidents.push({
      projectId,
      sessionId,
      fileKind: opts.fileKind,
      model: lastModel,
      gapStartMs: lastTs,
      gapEndMs: null,
      minutes: 0,
      outcome: 'truncated',
      cacheMissTokens: 0,
    });
  }

  return incidents;
}

// =============================================================================
// Corpus walk
// =============================================================================

export async function collectStalls(
  projectsRoot: string,
  opts: { projectArg?: string; minGapMs: number; sinceMs?: number; untilMs?: number }
): Promise<{ incidents: StallIncident[]; scannedFiles: number }> {
  let dirs: string[];
  if (opts.projectArg) {
    dirs = [opts.projectArg];
  } else {
    const es = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    dirs = es.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
  }
  const scanBase = opts.projectArg ? path.dirname(path.resolve(opts.projectArg)) : projectsRoot;

  const groups = await mapWithConcurrency(dirs, 8, listSessionFiles);
  const jobs: { file: string; kind: 'main' | 'subagent' }[] = [];
  for (const g of groups) {
    if (!g) continue;
    for (const f of g.sessionFiles) jobs.push({ file: f, kind: 'main' });
    for (const f of g.subagentFiles) jobs.push({ file: f, kind: 'subagent' });
  }
  const results = await mapWithConcurrency(jobs, 8, (j) =>
    scanFileForStalls(j.file, {
      minGapMs: opts.minGapMs,
      fileKind: j.kind,
      scanBase,
      sinceMs: opts.sinceMs,
      untilMs: opts.untilMs,
    })
  );
  let scannedFiles = 0;
  const incidents: StallIncident[] = [];
  for (const list of results) {
    if (!list) continue;
    scannedFiles++;
    incidents.push(...list);
  }
  return { incidents, scannedFiles };
}

// =============================================================================
// Aggregate + output
// =============================================================================

export function aggregate(incidents: StallIncident[]): StallAggregate {
  const agg: StallAggregate = {
    total: incidents.length,
    sessions: 0,
    byOutcome: { truncated: 0, 'api-error': 0, 'resumed-user': 0, 'resumed-continuation': 0 },
    byModel: {},
    byProject: {},
    byDay: {},
    totalStallMinutes: 0,
    totalCacheMissTokens: 0,
    durationsMinutes: [],
    wedgeDurationsMinutes: [],
    unclosed: 0,
  };
  const sessionKeys = new Set<string>();
  for (const i of incidents) {
    agg.byOutcome[i.outcome]++;
    if (i.model) agg.byModel[i.model] = (agg.byModel[i.model] ?? 0) + 1;
    agg.byProject[i.projectId] = (agg.byProject[i.projectId] ?? 0) + 1;
    const d = new Date(i.gapStartMs);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    agg.byDay[day] = (agg.byDay[day] ?? 0) + 1;
    if (i.gapEndMs !== null) {
      agg.totalStallMinutes += i.minutes;
      agg.durationsMinutes.push(i.minutes);
      if (i.outcome === 'resumed-continuation' || i.outcome === 'api-error') {
        agg.wedgeDurationsMinutes.push(i.minutes);
      }
    } else {
      agg.unclosed++;
    }
    agg.totalCacheMissTokens += i.cacheMissTokens;
    sessionKeys.add(`${i.projectId}/${i.sessionId}/${i.fileKind}`);
  }
  agg.sessions = sessionKeys.size;
  return agg;
}

const topEntries = (rec: Record<string, number>, n: number): [string, number][] =>
  Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

const localStamp = (ms: number): string => {
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
};

const OUTCOME_LABEL: Record<StallOutcome, string> = {
  truncated: 'truncated',
  'api-error': 'api-error',
  'resumed-user': 'user-resume',
  'resumed-continuation': 'cont-resume',
};

export function sortIncidents(
  incidents: StallIncident[],
  sort: StallScanOpts['sort']
): StallIncident[] {
  return [...incidents].sort((a, b) => {
    if (sort === 'start') return b.gapStartMs - a.gapStartMs;
    if (sort === 'project')
      return a.projectId.localeCompare(b.projectId) || b.gapStartMs - a.gapStartMs;
    return b.minutes - a.minutes || b.gapStartMs - a.gapStartMs;
  });
}

function printHuman(
  incidents: StallIncident[],
  agg: StallAggregate,
  opts: StallScanOpts,
  root: string,
  scannedFiles: number
): void {
  console.log(`stall-scan  gap>=${opts.minGapMinutes}m  corpus: ${root}`);
  console.log(
    `scanned ${scannedFiles} files → ${agg.total} incident(s) in ${agg.sessions} session(s)`
  );
  if (agg.total === 0) return;

  console.log('');
  console.log(
    `${pad('PROJECT', 30)}${pad('SESSION', 10)}${pad('KIND', 6)}${pad('START', 17)}${padL('DUR', 8)}${pad('  OUTCOME', 14)}${padL('MISS', 9)}  MODEL`
  );
  for (const i of sortIncidents(incidents, opts.sort).slice(0, opts.limit)) {
    const durStr = i.gapEndMs === null ? 'open' : dur(i.minutes * 60000);
    const miss = i.cacheMissTokens > 0 ? formatTokensCompact(i.cacheMissTokens) : '—';
    const kind = i.fileKind === 'main' ? 'main' : 'sub';
    const outcomeCell = `  ${OUTCOME_LABEL[i.outcome]}`;
    const row = [
      pad(short(i.projectId, 28), 30),
      pad(short(i.sessionId, 8), 10),
      pad(kind, 6),
      pad(localStamp(i.gapStartMs), 17),
      padL(durStr, 8),
      pad(outcomeCell, 14),
      padL(miss, 9),
      short(i.model ?? '—', 24),
    ].join('');
    console.log(row);
  }

  console.log('');
  const oc = agg.byOutcome;
  console.log(
    `by outcome: truncated ${oc.truncated} | api-error ${oc['api-error']} | user-resume ${oc['resumed-user']} | cont-resume ${oc['resumed-continuation']}`
  );
  console.log(
    `stall time: ${dur(agg.totalStallMinutes * 60000)} (closed gaps) · cache-miss full-price input: ${formatTokensCompact(agg.totalCacheMissTokens)}`
  );
  const p = percentiles(agg.durationsMinutes);
  if (p) {
    console.log(
      `duration p5/p50/p95: ${dur(p.p5 * 60000)} / ${dur(p.p50 * 60000)} / ${dur(p.p95 * 60000)} (closed, n=${agg.durationsMinutes.length})`
    );
  }
  const ladder = (title: string, xs: number[]): void => {
    const cells = [10, 20, 30, 60, 120].map((t) => `>${t}m ${xs.filter((x) => x > t).length}`);
    console.log(`${title}: ${cells.join(' | ')}`);
  };
  ladder(`ladder (closed, n=${agg.durationsMinutes.length})`, agg.durationsMinutes);
  ladder(
    `ladder (wedge profile, n=${agg.wedgeDurationsMinutes.length}, unclosed ${agg.unclosed})`,
    agg.wedgeDurationsMinutes
  );
  const fmtTop = (title: string, pairs: [string, number][]): void => {
    if (pairs.length) {
      const cells = pairs.map(([k, v]) => `${short(k, 30)} ${v}`);
      console.log(`${title}: ${cells.join(' | ')}`);
    }
  };
  fmtTop('by model', topEntries(agg.byModel, 5));
  fmtTop('by project', topEntries(agg.byProject, 8));
  fmtTop('by day', topEntries(agg.byDay, 5));
}

// =============================================================================
// Args + entry
// =============================================================================

const USAGE = `stall-scan — stalled-stream detection over ~/.claude/projects
Flags:
  --project <dir|encoded>  scan one project instead of all
  --min-gap MINUTES        minimum gap to flag (default 10)
  --since / --until DATE   incidents whose gap started in the window (YYYY-MM-DD)
  --last N                 last N calendar days
  --sort FIELD             minutes | start | project (default minutes)
  --limit N                incidents shown (default 50)
  --json                   machine-readable output`;

export function parseStallScanArgs(argv: string[]): StallScanOpts {
  const opts: StallScanOpts = { minGapMinutes: 10, sort: 'minutes', limit: 50, json: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const { value, next } = takeFlagValue(argv, i);
    if (a === '--project') {
      opts.projectArg = value;
      i = next;
      continue;
    }
    if (a === '--min-gap') {
      if (/^[1-9]\d*$/.test(value)) {
        opts.minGapMinutes = parseInt(value, 10);
        i = next;
      } else {
        opts.error = `--min-gap expects minutes >= 1, got '${value || '(missing)'}'`;
        i = next;
      }
      continue;
    }
    if (a === '--since' || a === '--until') {
      const d = parseDayBound(value, a === '--until');
      if (!d) opts.error = `invalid ${a} date (expected YYYY-MM-DD or YYYYMMDD): '${value}'`;
      else if (a === '--since') opts.since = d;
      else opts.until = d;
      i = next;
      continue;
    }
    if (a === '--last') {
      if (/^[1-9]\d*$/.test(value)) {
        opts.since = lastDaysSince(parseInt(value, 10));
        i = next;
      } else {
        opts.error = `--last expects a number of days >= 1, got '${value || '(missing)'}'`;
        i = next;
      }
      continue;
    }
    if (a === '--sort') {
      opts.sort = value === 'start' || value === 'project' ? value : 'minutes';
      i = next;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(value, 10);
      opts.limit = n > 0 ? n : 50;
      i = next;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      i += 1;
      continue;
    }
    if (!opts.error) opts.error = `unknown flag: '${a}' (see --help)`;
    i += 1;
  }
  return opts;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(USAGE);
    return;
  }
  const opts = parseStallScanArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }
  const root = getProjectsBasePath();
  const projectArg = opts.projectArg ? resolveProjectDir(opts.projectArg) : undefined;
  const { incidents, scannedFiles } = await collectStalls(root, {
    projectArg,
    minGapMs: opts.minGapMinutes * 60000,
    sinceMs: opts.since?.getTime(),
    untilMs: opts.until?.getTime(),
  });
  const agg = aggregate(incidents);
  if (opts.json) {
    console.log(
      JSON.stringify(
        { root, scannedFiles, minGapMinutes: opts.minGapMinutes, aggregate: agg, incidents },
        null,
        2
      )
    );
    return;
  }
  printHuman(incidents, agg, opts, root, scannedFiles);
}

if (isDirectRun(import.meta.url))
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
