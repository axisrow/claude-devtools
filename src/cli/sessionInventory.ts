/**
 * Sessions inventory CLI — duration, models, token totals across all sessions.
 * Answers "which sessions ran 2h+, on which model" without opening the app.
 *
 * Usage:
 *   pnpm analyze:sessions [--project <dir|encoded>] [flags]
 * Flags:
 *   --min-minutes N           only sessions with at least N minutes of active (API) time
 *   --min-turn-minutes N      only sessions whose longest turn ran at least N active minutes
 *   --min-streak N            only sessions where some back-to-back cycle ran at least N times (runs < 3x are never recorded)
 *   --sort FIELD              duration | active | turn | streak | tokens | date (default duration)
 *   --limit N                 show first N rows
 *   --breakdown               per-session model token split (models column + JSON tokensByModel)
 *   --since / --until DATE    filter by session last-activity date (YYYY-MM-DD or YYYYMMDD)
 *   --last N                  last-activity date within the last N calendar days
 *   --no-cost                 accepted for the shared grammar; inventory has no cost figures
 *   --json                    machine-readable output
 */

import { isParsedUserChunkMessage, type ParsedMessage } from '@main/types';
import {
  decodePath,
  extractSessionId,
  getProjectsBasePath,
  normalizeDriveLetter,
  translateWslMountPath,
} from '@main/utils/pathDecoder';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { pathToFileURL } from 'url';

import {
  bashStem,
  billingFromFlags,
  type BillingScheme,
  dur,
  normalizeCallKey,
  pad,
  padL,
  resolveProjectDir,
  short,
  TURN_IDLE_GAP_CAP_MINUTES,
  WASTE_THRESHOLDS,
} from './analyzeSession';
import { inDateRange, lastDaysSince, parseDayBound, takeFlagValue, wantsHelp } from './args';

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ScanEntry {
  type?: string;
  timestamp?: string;
  requestId?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  cwd?: string;
  message?: { model?: string; usage?: RawUsage; content?: unknown };
}

function mergeUsage(a: RawUsage, b: RawUsage): RawUsage {
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
  };
}

export interface InventoryEntry {
  projectId: string;
  sessionId: string;
  filePath: string;
  durationMs: number;
  /** API work time: capped gaps between main-chain usage lines (one anchor per requestId) — same cap as turnActiveMinutes */
  activeMs: number;
  /** longest single turn's active time — a 96h-active session may have no turn over 20 min */
  longestTurnMs: number;
  /** every maximal run of >= loopStreakMin back-to-back identical calls, longest first (cap 10) */
  cycles: { key: string; count: number; startTs: string; toolUseId: string }[];
  lastTs: Date | null;
  models: string[];
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  tokensByModel: Record<string, number>;
  sizeBytes: number;
  billing: BillingScheme;
  /** real project path from the session's cwd field — decodePath is lossy when the name has dashes */
  cwd?: string;
}

// ponytail: own streaming pass instead of parseJsonlFile — it materializes every
// ParsedMessage and that measurably blows up on 1200+ files incl. 66MB ones
export async function scanSessionFile(filePath: string): Promise<InventoryEntry | null> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let firstTs: number | null = null;
  let lastTs: number | null = null;
  let activeMs = 0;
  let turnActiveMs = 0;
  let longestTurnMs = 0;
  let prevUsageTs: number | null = null;
  let messageCount = 0;
  const seenCallIds = new Set<string>();
  // back-to-back run tracking: one entry per maximal run of >= loopStreakMin
  // identical calls. Buckets Bash by stem (pipe-cut) — analyze:session's
  // loop_streak keys on the full input, so the two may split one session
  let lastStreakKey = '';
  let curStreak = 0;
  let curStreakStartTs = '';
  let curStreakToolUseId = '';
  const runs: { key: string; count: number; startTs: string; toolUseId: string }[] = [];
  const flushStreak = (): void => {
    if (lastStreakKey && curStreak >= WASTE_THRESHOLDS.loopStreakMin) {
      runs.push({
        key: lastStreakKey,
        count: curStreak,
        startTs: curStreakStartTs,
        toolUseId: curStreakToolUseId,
      });
    }
  };
  const countCalls = (line: ScanEntry): void => {
    const m = line.message;
    if (!m || !Array.isArray(m.content)) return;
    for (const block of m.content) {
      const b = block as {
        type?: string;
        name?: string;
        id?: string;
        input?: Record<string, unknown>;
      };
      if (b?.type !== 'tool_use' || !b.name) continue;
      const dedupId = `${line.requestId ?? ''}|${b.id ?? ''}`;
      if (seenCallIds.has(dedupId)) continue;
      seenCallIds.add(dedupId);
      const key = bashStem(normalizeCallKey(b.name, b.input ?? {}));
      if (key === lastStreakKey) {
        curStreak += 1;
      } else {
        flushStreak();
        lastStreakKey = key;
        curStreak = 1;
        curStreakStartTs = line.timestamp ?? '';
      }
      curStreakToolUseId = b.id ?? curStreakToolUseId;
    }
  };
  let cwd: string | undefined;
  const models = new Set<string>();
  // anthropic-style rounds report cache writes; routers report cache_read with cw=0
  let sawWrite = false;
  let sawRead = false;
  const usageByRequestId = new Map<string, { model: string; usage: RawUsage }>();
  const directByModel = new Map<string, RawUsage>();

  for await (const line of rl) {
    if (line === '') continue;
    let e: ScanEntry;
    try {
      e = JSON.parse(line) as ScanEntry;
    } catch {
      continue;
    }
    if (!e.timestamp) continue;
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
    if (e.type === 'user' || e.type === 'assistant') messageCount++;
    // normalize like extractCwd: uppercase drive letter, WSL mount → Windows path
    if (!cwd && e.cwd) cwd = normalizeDriveLetter(translateWslMountPath(e.cwd));

    // turn boundary = real user message, via the same isParsedUserChunkMessage
    // guard buildLedger uses (system-output tags, array content, teammate pings
    // all behave identically — the divergence this way is structural). !isSidechain
    // stays local: sidechain lines never split the main-chain turn accounting.
    // cast: the guard reads only type/isMeta/content, all present on the raw line
    if (
      e.type === 'user' &&
      !e.isSidechain &&
      isParsedUserChunkMessage({
        type: e.type,
        isMeta: e.isMeta,
        content: e.message?.content,
      } as unknown as ParsedMessage)
    ) {
      longestTurnMs = Math.max(longestTurnMs, turnActiveMs);
      turnActiveMs = 0;
      prevUsageTs = null;
    }

    // calls are counted on ALL main-chain assistant lines — router sessions
    // log usage on a separate final line, so usage-gating would miss most;
    // seenCallIds keeps streaming snapshots from double-counting
    if (
      e.type === 'assistant' &&
      !e.isSidechain &&
      e.message &&
      e.message.model !== '<synthetic>'
    ) {
      countCalls(e);
    }

    // sidechain (subagent) entries stay out of totals/models/billing — same
    // accounting as buildLedger; timestamps and message count cover the file
    if (
      e.type === 'assistant' &&
      !e.isSidechain &&
      e.message?.usage &&
      e.message.model !== '<synthetic>'
    ) {
      // API time: gap to the previous main-chain usage line, capped — same
      // accounting as turnActiveMinutes, hours of silence cost zero. Streaming
      // snapshots of an already-seen requestId add no gap (analyze:session keeps
      // one round per request, anchored at the last line) but still advance the
      // anchor, so the next gap starts from the newest line of the request.
      const snapshot = e.requestId !== undefined && usageByRequestId.has(e.requestId);
      if (prevUsageTs !== null && !snapshot) {
        const gap = Math.min(Math.max(ts - prevUsageTs, 0), TURN_IDLE_GAP_CAP_MINUTES * 60000);
        activeMs += gap;
        turnActiveMs += gap;
      }
      prevUsageTs = ts;
      if (e.message.model) models.add(e.message.model);
      if (e.message.usage.cache_creation_input_tokens) sawWrite = true;
      else if (e.message.usage.cache_read_input_tokens) sawRead = true;
      // streaming writes several entries per request — the last one has final counts
      if (e.requestId) {
        usageByRequestId.set(e.requestId, {
          model: e.message.model ?? 'unknown',
          usage: e.message.usage,
        });
      } else {
        const m = e.message.model ?? 'unknown';
        directByModel.set(m, mergeUsage(directByModel.get(m) ?? {}, e.message.usage));
      }
    }
  }

  if (firstTs === null || lastTs === null) return null;
  longestTurnMs = Math.max(longestTurnMs, turnActiveMs);
  flushStreak();

  let totals: RawUsage = {};
  const byModel = new Map<string, RawUsage>();
  const acc = (model: string, u: RawUsage): void => {
    totals = mergeUsage(totals, u);
    byModel.set(model, mergeUsage(byModel.get(model) ?? {}, u));
  };
  for (const { model, usage } of usageByRequestId.values()) acc(model, usage);
  for (const [model, usage] of directByModel) acc(model, usage);

  const tokensByModel: Record<string, number> = {};
  for (const [model, u] of byModel) {
    tokensByModel[model] =
      (u.input_tokens ?? 0) +
      (u.output_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
  }

  const rel = path.relative(getProjectsBasePath(), path.resolve(filePath));
  const [projectId = '', sessionId = ''] = rel.split(path.sep);

  const inputTokens = totals.input_tokens ?? 0;
  const outputTokens = totals.output_tokens ?? 0;
  const cacheReadTokens = totals.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = totals.cache_creation_input_tokens ?? 0;

  return {
    projectId,
    sessionId: extractSessionId(sessionId),
    filePath,
    durationMs: Math.max(0, lastTs - firstTs),
    activeMs,
    longestTurnMs,
    cycles: runs.toSorted((a, b) => b.count - a.count).slice(0, 10),
    lastTs: new Date(lastTs),
    models: [...models],
    messageCount,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    tokensByModel,
    sizeBytes: fs.statSync(filePath).size,
    billing: billingFromFlags(sawWrite, sawRead),
    cwd,
  };
}

async function listSessionFiles(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.promises.readdir(projectDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')) {
      out.push(path.join(projectDir, e.name));
    }
  }
  return out;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (x: T) => Promise<R>
): Promise<(R | null)[]> {
  // ponytail: result order is nondeterministic — rows are sorted downstream anyway
  const results: (R | null)[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      try {
        results.push(await fn(item));
      } catch (err) {
        // one unreadable file must not abort a 1200+-file scan
        console.error(`(skipped ${String(item)}: ${String(err)})`);
        results.push(null);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function collect(projectsRoot: string, projectArg?: string): Promise<InventoryEntry[]> {
  let dirs: string[];
  if (projectArg) {
    dirs = [projectArg];
  } else {
    const es = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    dirs = es.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
  }
  const fileGroups = await mapWithConcurrency(dirs, 8, listSessionFiles);
  const files = fileGroups.filter((g): g is string[] => g !== null).flat();
  // ponytail: no mtime cache yet — first full scan is IO-bound seconds, add one if it hurts
  const scanned = await mapWithConcurrency(files, 8, scanSessionFile);
  return scanned.filter((e): e is InventoryEntry => e !== null);
}

const shortenHome = (p: string): string => {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface InventoryOpts {
  projectArg?: string;
  minMinutes: number;
  sort: 'duration' | 'active' | 'turn' | 'streak' | 'tokens' | 'date';
  limit: number;
  json: boolean;
  breakdown: boolean;
  minTurnMinutes: number;
  minStreak: number;
  since?: Date;
  until?: Date;
  error?: string;
}

export function parseInventoryArgs(argv: string[]): InventoryOpts {
  const opts: InventoryOpts = {
    minMinutes: 0,
    sort: 'duration',
    limit: Number.POSITIVE_INFINITY,
    json: false,
    breakdown: false,
    minTurnMinutes: 0,
    minStreak: 0,
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const { value, next } = takeFlagValue(argv, i);
    if (a === '--project') {
      opts.projectArg = value;
      i = next;
      continue;
    }
    if (a === '--min-minutes') {
      opts.minMinutes = parseInt(value, 10) || 0;
      i = next;
      continue;
    }
    if (a === '--min-turn-minutes') {
      opts.minTurnMinutes = parseInt(value, 10) || 0;
      i = next;
      continue;
    }
    if (a === '--min-streak') {
      opts.minStreak = parseInt(value, 10) || 0;
      i = next;
      continue;
    }
    if (a === '--sort') {
      opts.sort =
        value === 'tokens' ||
        value === 'date' ||
        value === 'active' ||
        value === 'turn' ||
        value === 'streak'
          ? value
          : 'duration';
      i = next;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(value, 10);
      opts.limit = n > 0 ? n : Number.POSITIVE_INFINITY;
      i = next;
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
        i += 1;
      }
      continue;
    }
    if (a === '--breakdown') {
      opts.breakdown = true;
      i += 1;
      continue;
    }
    // accepted for the shared grammar; the inventory carries no cost figures
    if (a === '--no-cost') {
      i += 1;
      continue;
    }
    if (a === '--json') {
      opts.json = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return opts;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(
      [
        'usage: pnpm analyze:sessions [--project <dir|encoded>] [flags]',
        '',
        'flags:',
        '  --min-minutes N           only sessions with at least N minutes of active (API) time',
        '  --min-turn-minutes N      only sessions whose longest turn ran at least N active minutes',
        `  --min-streak N            only sessions where some back-to-back cycle ran at least N times (floor: ${String(WASTE_THRESHOLDS.loopStreakMin)}x — shorter runs are not recorded)`,
        '  --sort FIELD              duration | active | turn | streak | tokens | date (default duration)',
        '  --limit N                 show first N rows',
        '  --breakdown               per-session model token split',
        '  --since DATE              only sessions whose last activity is on/after this date (YYYY-MM-DD or YYYYMMDD)',
        '  --until DATE              only sessions whose last activity is on/before this date',
        '  --last N                  sessions whose last activity falls in the last N calendar days',
        '  --no-cost                 accepted for the shared grammar; inventory has no cost figures',
        '  --json                    machine-readable output',
      ].join('\n')
    );
    return;
  }
  const opts = parseInventoryArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }

  let projectDir: string | undefined;
  if (opts.projectArg) {
    projectDir = resolveProjectDir(opts.projectArg);
    if (!fs.existsSync(projectDir)) {
      console.error(`project dir not found: ${opts.projectArg}`);
      process.exitCode = 1;
      return;
    }
  }

  const entries = await collect(getProjectsBasePath(), projectDir);
  entries.sort((a, b) => {
    if (opts.sort === 'tokens') return b.totalTokens - a.totalTokens;
    if (opts.sort === 'date') return (b.lastTs?.getTime() ?? 0) - (a.lastTs?.getTime() ?? 0);
    if (opts.sort === 'active') return b.activeMs - a.activeMs;
    if (opts.sort === 'turn') return b.longestTurnMs - a.longestTurnMs;
    if (opts.sort === 'streak') {
      return (b.cycles[0]?.count ?? 0) - (a.cycles[0]?.count ?? 0);
    }
    return b.durationMs - a.durationMs;
  });
  const hasDateFilter = opts.since !== undefined || opts.until !== undefined;
  // heuristic: a session's date = its LAST activity; a session that started
  // before --since still matches if it ended inside the window, but one that
  // ran past --until drops out
  const shown = entries
    .filter((e) => e.activeMs >= opts.minMinutes * 60000)
    .filter((e) => e.longestTurnMs >= opts.minTurnMinutes * 60000)
    .filter((e) => (e.cycles[0]?.count ?? 0) >= opts.minStreak)
    .filter((e) =>
      hasDateFilter ? e.lastTs !== null && inDateRange(e.lastTs, opts.since, opts.until) : true
    )
    .slice(0, opts.limit);

  if (opts.json) {
    // tokensByModel surfaces only with --breakdown; default JSON stays as before
    const out = shown.map((e) => {
      if (opts.breakdown) return e;
      const copy = { ...e };
      delete (copy as Partial<InventoryEntry>).tokensByModel;
      return copy;
    });
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const notes: string[] = [];
  if (opts.minMinutes > 0) notes.push(`>= ${String(opts.minMinutes)} min active`);
  if (opts.minTurnMinutes > 0) notes.push(`turn >= ${String(opts.minTurnMinutes)} min`);
  if (opts.minStreak > 0) notes.push(`cycle >= ${String(opts.minStreak)}x`);
  if (opts.since && opts.until) notes.push(`${ymd(opts.since)}..${ymd(opts.until)}`);
  else if (opts.since) notes.push(`since ${ymd(opts.since)}`);
  else if (opts.until) notes.push(`until ${ymd(opts.until)}`);
  const note = notes.length > 0 ? ` (${notes.join(', ')})` : '';
  console.log(`sessions: ${entries.length} total, showing ${shown.length}${note}`);
  console.log();
  console.log(
    `${padL('active', 9)} ${padL('wall', 9)} ${padL('max turn', 8)} ${padL('cycle', 9)} ${pad('date', 11)} ${pad('file', 9)} ${pad('project', 42)} ${pad(opts.breakdown ? 'by model (share)' : 'models', 30)} ${padL('tokens', 9)} ${padL('msgs', 6)} ${pad('billing', 15)}`
  );
  for (const e of shown) {
    // real path from the session beats decoding the encoded dir name (lossy on dashes)
    const project = e.cwd ? shortenHome(e.cwd) : shortenHome(decodePath(e.projectId));
    const models = opts.breakdown ? modelShareCell(e) : e.models.join(', ');
    console.log(
      `${padL(dur(e.activeMs), 9)} ${padL(dur(e.durationMs), 9)} ${padL(dur(e.longestTurnMs), 8)} ${padL(cycleCell(e), 9)} ${pad(e.lastTs ? e.lastTs.toISOString().slice(0, 10) : 'n/a', 11)} ${pad(e.sessionId.slice(0, 8), 9)} ${pad(short(project, 42), 42)} ${pad(short(models, 30), 30)} ${padL(formatTokensCompact(e.totalTokens), 9)} ${padL(String(e.messageCount), 6)} ${pad(e.billing, 15)}`
    );
  }
}

// "2c/40x" — number of distinct back-to-back cycles and the longest one
const cycleCell = (e: InventoryEntry): string =>
  e.cycles.length > 0 ? `${String(e.cycles.length)}c/${String(e.cycles[0].count)}x` : '-';

function modelShareCell(e: InventoryEntry): string {
  const total = Object.values(e.tokensByModel).reduce((s, v) => s + v, 0);
  if (total === 0) return 'n/a';
  return Object.entries(e.tokensByModel)
    .sort((a, b) => b[1] - a[1])
    .map(([m, v]) => `${m} ${Math.round((v / total) * 100)}%`)
    .join(', ');
}

// run only when executed directly — vitest imports this file for scanSessionFile
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
