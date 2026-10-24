/**
 * tool-stats CLI — tool usage statistics across all ~/.claude/projects sessions.
 *
 * Answers "which tools do I actually use, where do they fail, what floods the
 * context" over the whole corpus without opening the app: per-tool call/error/
 * orphan counts, result volume, durations, per-project and per-day breakdowns,
 * main-chain vs subagent (sidechain) split, Task by subagent type, Bash exit
 * codes, API-error counts (synthetic "API Error: ..." lines), and P5–P95
 * outlier bands flagging sessions and projects that deviate from the norm.
 *
 * Usage:
 *   tool-stats [--project <dir|encoded>] [flags]
 * Flags:
 *   --project <dir|encoded>  scan one project instead of all
 *   --since / --until DATE   filter by session last-activity date (YYYY-MM-DD or YYYYMMDD)
 *   --last N                 last-activity date within the last N calendar days
 *   --day-window N           call-level slice: only calls made in the last N calendar days
 *   --sort FIELD             calls | errors | tokens | name (default calls)
 *   --limit N                show first N rows (default 20)
 *   --by-day                 per-date call counts
 *   --sessions               include per-session rows
 *   --json                   machine-readable output
 */

import {
  decodePath,
  extractSessionId,
  getProjectsBasePath,
  normalizeDriveLetter,
  translateWslMountPath,
} from '@main/utils/pathDecoder';
import { estimateContentTokens, formatTokensCompact } from '@shared/utils/tokenFormatting';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import { pad, padL, resolveProjectDir, short } from './analyzeSession';
import {
  inDateRange,
  isDirectRun,
  lastDaysSince,
  parseDayBound,
  takeFlagValue,
  wantsHelp,
} from './args';
import { mapWithConcurrency } from './sessionInventory';

// =============================================================================
// Types
// =============================================================================

/** Counters for one tool name. Invariant: calls === results + orphanCalls. */
export interface ToolStat {
  /** tool_use blocks, deduped by tool_use id */
  calls: number;
  /** matched tool_results */
  results: number;
  /** results with is_error */
  errors: number;
  /** calls whose result never arrived (interrupted / rejected) */
  orphanCalls: number;
  /** Σ estimateContentTokens(result content) */
  resultTokens: number;
  /** Σ (result ts − call ts) over completed calls */
  durationMs: number;
}

export interface Percentiles {
  p5: number;
  p50: number;
  p95: number;
}

export interface ApiErrorStats {
  /** synthetic assistant lines containing "API Error" */
  count: number;
  /** message text after "API Error:" (≤120 chars) → count */
  byText: Record<string, number>;
}

/** Per-session tool statistics as produced by the scan. */
export interface SessionToolStats {
  projectId: string;
  sessionId: string;
  /** real project path from the session's cwd field */
  cwd?: string;
  lastTs: Date | null;
  /** isSidechain = false (direct calls) */
  main: Record<string, ToolStat>;
  /** isSidechain = true (inside subagents) */
  subagent: Record<string, ToolStat>;
  /** Task calls by input.subagent_type (main chain only) */
  taskByType: Record<string, ToolStat>;
  /** local call date → tool → calls */
  byDay: Record<string, Record<string, number>>;
  /** Bash results with a parseable exit code, code → count (main + subagent) */
  bashExitCodes: Record<string, number>;
  apiErrors: ApiErrorStats;
  /** pooled per-call durations per tool (main + subagent) — band samples */
  toolDurationsMs: Record<string, number[]>;
}

export interface ToolPercentileBands {
  callsPerSession: Percentiles;
  errorsPerSession: Percentiles;
  resultTokensPerSession: Percentiles;
  durationPerSessionMs: Percentiles;
  durationPerCallMs: Percentiles;
  apiErrorsPerSession: Percentiles;
}

export type OutlierMetric = 'calls' | 'errors' | 'resultTokens' | 'durationMs' | 'apiErrors';

export interface OutlierRow {
  scope: 'session' | 'project';
  projectId: string;
  sessionId?: string;
  tool: string;
  metric: OutlierMetric;
  value: number;
  band: Percentiles;
}

export interface ToolStatsAggregate {
  sessions: number;
  totalCalls: number;
  /** main + subagent merged, whole corpus */
  byTool: Record<string, ToolStat>;
  byProject: Record<
    string,
    { name?: string; sessions: number; calls: number; errors: number; resultTokens: number }
  >;
  /** local date → tool → calls */
  byDay: Record<string, Record<string, number>>;
  /** Task calls by subagent_type */
  taskByType: Record<string, ToolStat>;
  bashExitCodes: Record<string, number>;
  apiErrors: ApiErrorStats;
  /** P5/P50/P95 bands per tool; null when samples < MIN_SESSIONS_FOR_OUTLIERS */
  byToolPercentiles: Record<string, ToolPercentileBands | null>;
  /** sessions/projects outside their tool's P5–P95 band, worst first, capped */
  outliers: OutlierRow[];
}

// ponytail: raw sample arrays instead of histograms — million-call corpora are
// a few MB per run; switch to histograms only if memory ever hurts
interface ToolAcc extends ToolStat {
  durationsMs: number[];
}

interface PendingCall {
  name: string;
  sub: boolean;
  ts: number;
  /** set for main-chain Task calls — routes results into taskByType */
  taskType?: string;
}

interface ScanLine {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  cwd?: string;
  toolUseResult?: unknown;
  message?: { model?: string; content?: unknown };
}

/** tools with fewer session samples than this get no band and no outlier rows */
export const MIN_SESSIONS_FOR_OUTLIERS = 5;
export const MAX_OUTLIERS = 100;
const API_ERROR_PREFIX = 'API Error';

// =============================================================================
// Pure helpers
// =============================================================================

export function emptyToolStat(): ToolStat {
  return { calls: 0, results: 0, errors: 0, orphanCalls: 0, resultTokens: 0, durationMs: 0 };
}

/** Pure sum of two stats — no parameter mutation. */
export function sumToolStat(a: ToolStat, b: ToolStat): ToolStat {
  return {
    calls: a.calls + b.calls,
    results: a.results + b.results,
    errors: a.errors + b.errors,
    orphanCalls: a.orphanCalls + b.orphanCalls,
    resultTokens: a.resultTokens + b.resultTokens,
    durationMs: a.durationMs + b.durationMs,
  };
}

/** Interpolated (numpy-style) P5/P50/P95; null for empty samples. */
export function percentiles(samples: number[]): Percentiles | null {
  if (samples.length === 0) return null;
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number): number => {
    const pos = (p / 100) * (s.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
  };
  return { p5: q(5), p50: q(50), p95: q(95) };
}

const EXIT_CODE_RE = /Exit code:?\s*(\d+)/i;

/** Bash exit code: structured toolUseResult.exitCode first, then result text. */
export function parseExitCode(toolUseResult: unknown, content: unknown): string | null {
  if (toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)) {
    const v = (toolUseResult as Record<string, unknown>).exitCode;
    if (typeof v === 'number') return String(v);
  }
  const m = EXIT_CODE_RE.exec(resultText(content));
  return m ? m[1] : null;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && typeof (b as Record<string, unknown>).text === 'string'
          ? ((b as Record<string, unknown>).text as string)
          : ''
      )
      .join('\n');
  }
  return '';
}

/** "API Error: <text>" → normalized key; null when the line is not an API error. */
export function parseApiErrorKey(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith(API_ERROR_PREFIX)) return null;
  return t.slice(API_ERROR_PREFIX.length).replace(/^:\s*/, '').trim().slice(0, 120);
}

const emptyAcc = (): ToolAcc => ({ ...emptyToolStat(), durationsMs: [] });

// =============================================================================
// Per-session scan (streaming — parseJsonlFile materializes and dies on 66MB files)
// =============================================================================

export async function scanSessionToolStats(
  filePath: string,
  minCallTs?: number
): Promise<SessionToolStats | null> {
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const rel = path.relative(getProjectsBasePath(), path.resolve(filePath));
  const [projectDir = '', sessionFile = ''] = rel.split(path.sep);
  const mainTools = new Map<string, ToolAcc>();
  const subagent = new Map<string, ToolAcc>();
  const taskByType = new Map<string, ToolAcc>();
  const byDay = new Map<string, Map<string, number>>();
  const bashExitCodes: Record<string, number> = {};
  const apiErrors: ApiErrorStats = { count: 0, byText: {} };
  const toolDurationsMs: Record<string, number[]> = {};
  // tool_use ids are unique per call — retries repeat the same id, so a plain
  // seen-set keeps streaming snapshots from double-counting
  const seenCallIds = new Set<string>();
  const pending = new Map<string, PendingCall>();
  let cwd: string | undefined;
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  const accFor = (map: Map<string, ToolAcc>, key: string): ToolAcc => {
    let a = map.get(key);
    if (!a) {
      a = emptyAcc();
      map.set(key, a);
    }
    return a;
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
    const ts = new Date(e.timestamp).getTime();
    if (Number.isNaN(ts)) continue;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
    if (!cwd && e.cwd) cwd = normalizeDriveLetter(translateWslMountPath(e.cwd));
    // day-window: a call-level slice — calls are counted by CALL timestamp;
    // results arriving in-window for out-of-window calls are dropped
    if (minCallTs !== undefined && ts < minCallTs) continue;

    const content = e.message?.content;
    if (e.type === 'assistant' && Array.isArray(content)) {
      // synthetic assistant lines are the canonical carrier of API errors
      // (same marker isParsedHardNoiseMessage filters on)
      if (e.message?.model === '<synthetic>') {
        const key = parseApiErrorKey(resultText(content));
        if (key !== null) {
          apiErrors.count += 1;
          apiErrors.byText[key] = (apiErrors.byText[key] ?? 0) + 1;
        }
        continue;
      }
      const sub = e.isSidechain === true;
      const day = ymd(new Date(ts));
      for (const block of content) {
        const b = block as { type?: string; id?: string; name?: string; input?: unknown };
        if (b?.type !== 'tool_use' || !b.id || !b.name) continue;
        if (seenCallIds.has(b.id)) continue;
        seenCallIds.add(b.id);
        accFor(sub ? subagent : mainTools, b.name).calls += 1;
        if (!sub) {
          const dayMap = byDay.get(day) ?? new Map<string, number>();
          byDay.set(day, dayMap);
          dayMap.set(b.name, (dayMap.get(b.name) ?? 0) + 1);
        }
        let taskType: string | undefined;
        if (b.name === 'Task' && !sub) {
          const rawType = (b.input ?? {}) as Record<string, unknown>;
          const rawSubagentType = rawType.subagent_type;
          taskType =
            typeof rawSubagentType === 'string' && rawSubagentType !== ''
              ? rawSubagentType
              : 'unknown';
          accFor(taskByType, taskType).calls += 1;
        }
        pending.set(b.id, { name: b.name, sub, ts, taskType });
      }
    } else if (e.type === 'user' && Array.isArray(content)) {
      const tur = e.toolUseResult;
      for (const block of content) {
        const b = block as {
          type?: string;
          tool_use_id?: string;
          is_error?: boolean;
          content?: unknown;
        };
        if (b?.type !== 'tool_result' || !b.tool_use_id) continue;
        const call = pending.get(b.tool_use_id);
        if (!call) continue; // result without an in-file call — not counted
        pending.delete(b.tool_use_id);
        const tokens = estimateContentTokens((b.content ?? '') as string | unknown[]);
        const delta = Math.max(ts - call.ts, 0);
        const acc = accFor(call.sub ? subagent : mainTools, call.name);
        acc.results += 1;
        if (b.is_error === true) acc.errors += 1;
        acc.durationMs += delta;
        acc.resultTokens += tokens;
        if (toolDurationsMs[call.name]) toolDurationsMs[call.name].push(delta);
        else toolDurationsMs[call.name] = [delta];
        if (call.taskType !== undefined) {
          const t = accFor(taskByType, call.taskType);
          t.results += 1;
          if (b.is_error === true) t.errors += 1;
          t.durationMs += delta;
          t.resultTokens += tokens;
        }
        if (call.name === 'Bash') {
          const code = parseExitCode(tur, b.content);
          if (code !== null) bashExitCodes[code] = (bashExitCodes[code] ?? 0) + 1;
        }
      }
    }
  }

  if (firstTs === null) return null;

  // calls whose result never arrived
  for (const call of pending.values()) {
    accFor(call.sub ? subagent : mainTools, call.name).orphanCalls += 1;
    if (call.taskType !== undefined) accFor(taskByType, call.taskType).orphanCalls += 1;
  }

  return {
    projectId: projectDir,
    sessionId: extractSessionId(sessionFile),
    cwd,
    lastTs: lastTs !== null ? new Date(lastTs) : null,
    main: Object.fromEntries(mainTools),
    subagent: Object.fromEntries(subagent),
    taskByType: Object.fromEntries(taskByType),
    byDay: Object.fromEntries([...byDay].map(([d, m]) => [d, Object.fromEntries(m)])),
    bashExitCodes,
    apiErrors,
    toolDurationsMs,
  };
}

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// =============================================================================
// Aggregate
// =============================================================================

/** Per-project per-tool accumulator for the project outlier means. */
interface ProjectToolAcc {
  stat: ToolStat;
  /** sessions in the project that used this tool — the band's sample population */
  sessions: number;
  /** Σ apiErrors.count over those sessions */
  apiErrors: number;
}

const accForProjectTool = (m: Map<string, ProjectToolAcc>, tool: string): ProjectToolAcc => {
  let a = m.get(tool);
  if (!a) {
    a = { stat: emptyToolStat(), sessions: 0, apiErrors: 0 };
    m.set(tool, a);
  }
  return a;
};

export function aggregate(sessions: SessionToolStats[]): ToolStatsAggregate {
  const byTool = new Map<string, ToolStat>();
  const byProject = new Map<
    string,
    { name?: string; sessions: number; calls: number; errors: number; resultTokens: number }
  >();
  const projectCwd = new Map<string, string>();
  const byDay = new Map<string, Map<string, number>>();
  const taskByType = new Map<string, ToolStat>();
  const bashExitCodes: Record<string, number> = {};
  const apiErrors: ApiErrorStats = { count: 0, byText: {} };
  // band samples per tool (one entry per session that used the tool)
  const callsSamples = new Map<string, number[]>();
  const errorsSamples = new Map<string, number[]>();
  const resultTokSamples = new Map<string, number[]>();
  const durSumSamples = new Map<string, number[]>();
  const apiErrSamples = new Map<string, number[]>();
  const pooledDurations = new Map<string, number[]>();
  // per-project per-tool sums for the project outlier means
  const projectTool = new Map<string, Map<string, ProjectToolAcc>>();

  const sample = (m: Map<string, number[]>, tool: string, v: number): void => {
    if (m.has(tool)) m.get(tool)!.push(v);
    else m.set(tool, [v]);
  };

  for (const s of sessions) {
    const proj = byProject.get(s.projectId) ?? {
      sessions: 0,
      calls: 0,
      errors: 0,
      resultTokens: 0,
    };
    if (!byProject.has(s.projectId)) byProject.set(s.projectId, proj);
    proj.sessions += 1;
    if (s.cwd && !projectCwd.has(s.projectId)) projectCwd.set(s.projectId, s.cwd);

    const perTool = projectTool.get(s.projectId) ?? new Map<string, ProjectToolAcc>();
    projectTool.set(s.projectId, perTool);
    const toolsThisSession = new Set<string>();

    for (const map of [s.main, s.subagent]) {
      for (const [tool, stat] of Object.entries(map)) {
        toolsThisSession.add(tool);
        byTool.set(tool, sumToolStat(byTool.get(tool) ?? emptyToolStat(), stat));
        proj.calls += stat.calls;
        proj.errors += stat.errors;
        proj.resultTokens += stat.resultTokens;
        const acc = accForProjectTool(perTool, tool);
        acc.stat = sumToolStat(acc.stat, stat);
      }
    }
    for (const tool of toolsThisSession) {
      // the band's sample population is sessions that used the tool — the
      // project mean must divide by the same population, not all sessions
      const acc = accForProjectTool(perTool, tool);
      acc.sessions += 1;
      acc.apiErrors += s.apiErrors.count;
      const merged = mergeToolStat(s, tool);
      sample(callsSamples, tool, merged.calls);
      sample(errorsSamples, tool, merged.errors);
      sample(resultTokSamples, tool, merged.resultTokens);
      sample(durSumSamples, tool, merged.durationMs);
      sample(apiErrSamples, tool, s.apiErrors.count);
    }

    for (const [day, tools] of Object.entries(s.byDay)) {
      const dayMap = byDay.get(day) ?? new Map<string, number>();
      byDay.set(day, dayMap);
      for (const [tool, n] of Object.entries(tools)) {
        dayMap.set(tool, (dayMap.get(tool) ?? 0) + n);
      }
    }
    for (const [type, stat] of Object.entries(s.taskByType)) {
      taskByType.set(type, sumToolStat(taskByType.get(type) ?? emptyToolStat(), stat));
    }
    for (const [code, n] of Object.entries(s.bashExitCodes)) {
      bashExitCodes[code] = (bashExitCodes[code] ?? 0) + n;
    }
    apiErrors.count += s.apiErrors.count;
    for (const [key, n] of Object.entries(s.apiErrors.byText)) {
      apiErrors.byText[key] = (apiErrors.byText[key] ?? 0) + n;
    }
    for (const [tool, durations] of Object.entries(s.toolDurationsMs)) {
      if (pooledDurations.has(tool)) pooledDurations.get(tool)!.push(...durations);
      else pooledDurations.set(tool, [...durations]);
    }
  }
  for (const [projectId, cwdPath] of projectCwd) {
    const proj = byProject.get(projectId);
    if (proj) proj.name = shortenHome(cwdPath);
  }

  const bands: Record<string, ToolPercentileBands | null> = {};
  for (const [tool, calls] of callsSamples) {
    if (calls.length < MIN_SESSIONS_FOR_OUTLIERS) continue;
    const p = (m: Map<string, number[]>): Percentiles => percentiles(m.get(tool) ?? [])!;
    bands[tool] = {
      callsPerSession: p(callsSamples),
      errorsPerSession: p(errorsSamples),
      resultTokensPerSession: p(resultTokSamples),
      durationPerSessionMs: p(durSumSamples),
      durationPerCallMs: p(pooledDurations),
      apiErrorsPerSession: p(apiErrSamples),
    };
  }

  const outliers: OutlierRow[] = [];
  const check = (
    scope: OutlierRow['scope'],
    projectId: string,
    sessionId: string | undefined,
    tool: string,
    metric: OutlierMetric,
    value: number,
    band: Percentiles
  ): void => {
    if (value > band.p95 || value < band.p5) {
      outliers.push({ scope, projectId, sessionId, tool, metric, value, band });
    }
  };
  for (const s of sessions) {
    for (const tool of Object.keys(bands)) {
      if (!usedTool(s, tool)) continue;
      const band = bands[tool]!;
      const merged = mergeToolStat(s, tool);
      check('session', s.projectId, s.sessionId, tool, 'calls', merged.calls, band.callsPerSession);
      check(
        'session',
        s.projectId,
        s.sessionId,
        tool,
        'errors',
        merged.errors,
        band.errorsPerSession
      );
      check(
        'session',
        s.projectId,
        s.sessionId,
        tool,
        'resultTokens',
        merged.resultTokens,
        band.resultTokensPerSession
      );
      check(
        'session',
        s.projectId,
        s.sessionId,
        tool,
        'durationMs',
        merged.durationMs,
        band.durationPerSessionMs
      );
      check(
        'session',
        s.projectId,
        s.sessionId,
        tool,
        'apiErrors',
        s.apiErrors.count,
        band.apiErrorsPerSession
      );
    }
  }
  // project outliers compare the project's per-session mean against the same band
  for (const [projectId, perTool] of projectTool) {
    for (const [tool, acc] of perTool) {
      const band = bands[tool];
      if (!band || acc.sessions === 0) continue;
      check(
        'project',
        projectId,
        undefined,
        tool,
        'calls',
        acc.stat.calls / acc.sessions,
        band.callsPerSession
      );
      check(
        'project',
        projectId,
        undefined,
        tool,
        'errors',
        acc.stat.errors / acc.sessions,
        band.errorsPerSession
      );
      check(
        'project',
        projectId,
        undefined,
        tool,
        'resultTokens',
        acc.stat.resultTokens / acc.sessions,
        band.resultTokensPerSession
      );
      check(
        'project',
        projectId,
        undefined,
        tool,
        'durationMs',
        acc.stat.durationMs / acc.sessions,
        band.durationPerSessionMs
      );
      check(
        'project',
        projectId,
        undefined,
        tool,
        'apiErrors',
        acc.apiErrors / acc.sessions,
        band.apiErrorsPerSession
      );
    }
  }
  outliers.sort((a, b) => excess(b) - excess(a));
  outliers.length = Math.min(outliers.length, MAX_OUTLIERS);

  return {
    sessions: sessions.length,
    totalCalls: [...byTool.values()].reduce((sum, s) => sum + s.calls, 0),
    byTool: Object.fromEntries(byTool),
    byProject: Object.fromEntries(byProject),
    byDay: Object.fromEntries([...byDay].map(([d, m]) => [d, Object.fromEntries(m)])),
    taskByType: Object.fromEntries(taskByType),
    bashExitCodes,
    apiErrors,
    byToolPercentiles: bands,
    outliers,
  };
}

function usedTool(s: SessionToolStats, tool: string): boolean {
  return tool in s.main || tool in s.subagent;
}

function mergeToolStat(s: SessionToolStats, tool: string): ToolStat {
  return sumToolStat(s.main[tool] ?? emptyToolStat(), s.subagent[tool] ?? emptyToolStat());
}

const excess = (o: OutlierRow): number =>
  o.value > o.band.p95
    ? (o.value - o.band.p95) / Math.max(o.band.p95, 1)
    : (o.band.p5 - o.value) / Math.max(o.band.p5, 1);

// =============================================================================
// CLI plumbing
// =============================================================================

const shortenHome = (p: string): string => {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

export interface ToolStatsOpts {
  projectArg?: string;
  since?: Date;
  until?: Date;
  /** call-level slice: only calls with ts >= local midnight of (today − N + 1) */
  dayWindow?: number;
  sort: 'calls' | 'errors' | 'tokens' | 'name';
  limit: number;
  byDay: boolean;
  sessions: boolean;
  json: boolean;
  error?: string;
}

export function parseToolStatsArgs(argv: string[]): ToolStatsOpts {
  const opts: ToolStatsOpts = {
    sort: 'calls',
    limit: 20,
    byDay: false,
    sessions: false,
    json: false,
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
    if (a === '--day-window') {
      if (/^[1-9]\d*$/.test(value)) {
        opts.dayWindow = parseInt(value, 10);
        i = next;
      } else {
        opts.error = `--day-window expects a number of days >= 1, got '${value || '(missing)'}'`;
        i += 1;
      }
      continue;
    }
    if (a === '--sort') {
      opts.sort = value === 'errors' || value === 'tokens' || value === 'name' ? value : 'calls';
      i = next;
      continue;
    }
    if (a === '--limit') {
      const n = parseInt(value, 10);
      opts.limit = n > 0 ? n : 20;
      i = next;
      continue;
    }
    if (a === '--by-day') {
      opts.byDay = true;
      i += 1;
      continue;
    }
    if (a === '--sessions') {
      opts.sessions = true;
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

async function listSessionFiles(projectDir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.promises.readdir(projectDir, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.jsonl') && !e.name.startsWith('agent-')) {
      out.push(path.join(projectDir, e.name));
    }
  }
  return out;
}

async function collect(
  projectsRoot: string,
  projectArg?: string,
  minCallTs?: number
): Promise<SessionToolStats[]> {
  let dirs: string[];
  if (projectArg) {
    dirs = [projectArg];
  } else {
    const es = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    dirs = es.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
  }
  const fileGroups = await mapWithConcurrency(dirs, 8, listSessionFiles);
  const files = fileGroups.filter((g): g is string[] => g !== null).flat();
  const scanned = await mapWithConcurrency(files, 8, (f) => scanSessionToolStats(f, minCallTs));
  return scanned.filter((s): s is SessionToolStats => s !== null);
}

function sortSessions(
  sessions: SessionToolStats[],
  sort: ToolStatsOpts['sort']
): SessionToolStats[] {
  const total = (s: SessionToolStats): ToolStat => mergeAll(s);
  return [...sessions].sort((a, b) => {
    if (sort === 'errors') return total(b).errors - total(a).errors;
    if (sort === 'tokens') return total(b).resultTokens - total(a).resultTokens;
    if (sort === 'name') return a.projectId.localeCompare(b.projectId);
    return total(b).calls - total(a).calls;
  });
}

function mergeAll(s: SessionToolStats): ToolStat {
  const all = Object.values(s.main).concat(Object.values(s.subagent));
  return all.reduce((acc, st) => sumToolStat(acc, st), emptyToolStat());
}

/** ms-precision duration for tool calls — dur() renders at minute granularity */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000)
    return `${Math.floor(ms / 60000)}m${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
  return `${Math.round(ms / 3600000)}h`;
}

function printHuman(
  agg: ToolStatsAggregate,
  sessions: SessionToolStats[],
  opts: ToolStatsOpts
): void {
  const notes: string[] = [];
  if (opts.since && opts.until) notes.push(`${ymd(opts.since)}..${ymd(opts.until)}`);
  else if (opts.since) notes.push(`since ${ymd(opts.since)}`);
  else if (opts.until) notes.push(`until ${ymd(opts.until)}`);
  if (opts.dayWindow !== undefined) notes.push(`day-window: last ${opts.dayWindow} day(s)`);
  const note = notes.length > 0 ? ` (${notes.join(', ')})` : '';

  const tools = Object.entries(agg.byTool);
  const sorters: Record<
    ToolStatsOpts['sort'],
    (a: [string, ToolStat], b: [string, ToolStat]) => number
  > = {
    calls: (a, b) => b[1].calls - a[1].calls,
    errors: (a, b) => b[1].errors - a[1].errors,
    tokens: (a, b) => b[1].resultTokens - a[1].resultTokens,
    name: (a, b) => a[0].localeCompare(b[0]),
  };
  const shown = tools.toSorted(sorters[opts.sort]).slice(0, opts.limit);
  const callTotal = Math.max(agg.totalCalls, 1);

  console.log(
    `tool usage — ${agg.sessions} sessions in ${Object.keys(agg.byProject).length} projects, ${formatTokensCompact(agg.totalCalls)} calls${note}`
  );
  console.log();
  console.log(
    `${pad('tool', 28)} ${padL('calls', 7)} ${padL('share', 6)} ${padL('errors', 7)} ${padL('err%', 6)} ${padL('orphan', 7)} ${padL('result-tok', 11)} ${padL('avg-ms', 8)} ${padL('p95-ms', 9)}`
  );
  for (const [tool, st] of shown) {
    const band = agg.byToolPercentiles[tool];
    const share = ((st.calls / callTotal) * 100).toFixed(1) + '%';
    const errPct = st.results > 0 ? ((st.errors / st.results) * 100).toFixed(1) + '%' : '-';
    const avgMs = st.results > 0 ? fmtMs(st.durationMs / st.results) : '-';
    const p95Ms = band ? fmtMs(band.durationPerCallMs.p95) : '-';
    console.log(
      `${pad(short(tool, 28), 28)} ${padL(String(st.calls), 7)} ${padL(share, 6)} ${padL(String(st.errors), 7)} ${padL(errPct, 6)} ${padL(String(st.orphanCalls), 7)} ${padL(formatTokensCompact(st.resultTokens), 11)} ${padL(avgMs, 8)} ${padL(p95Ms, 9)}`
    );
  }

  const codes = Object.entries(agg.bashExitCodes).sort((a, b) => b[1] - a[1]);
  if (codes.length > 0) {
    const bashResults = agg.byTool.Bash?.results ?? 0;
    const nonZero = codes.filter(([c]) => c !== '0').reduce((s, [, n]) => s + n, 0);
    const rate =
      bashResults > 0 ? ` (non-zero ${((nonZero / bashResults) * 100).toFixed(1)}%)` : '';
    console.log();
    console.log(
      `bash exit codes:${rate} ${codes
        .slice(0, 8)
        .map(([c, n]) => `${c}=${formatTokensCompact(n)}`)
        .join('  ')}`
    );
  }

  if (agg.apiErrors.count > 0) {
    const top = Object.entries(agg.apiErrors.byText)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([t, n]) => `"${short(t, 60)}" ${formatTokensCompact(n)}`)
      .join(', ');
    console.log();
    console.log(
      `api errors: ${formatTokensCompact(agg.apiErrors.count)} (${(agg.apiErrors.count / Math.max(agg.sessions, 1)).toFixed(2)}/sess) — top: ${top}`
    );
  }

  const taskTypes = Object.entries(agg.taskByType).sort((a, b) => b[1].calls - a[1].calls);
  if (taskTypes.length > 0) {
    console.log();
    console.log('task subagent types:');
    for (const [type, st] of taskTypes.slice(0, 10)) {
      console.log(
        `  ${pad(short(type, 30), 30)} ${padL(String(st.calls), 6)} calls ${padL(String(st.errors), 5)} errors ${padL(formatTokensCompact(st.resultTokens), 10)} result-tok`
      );
    }
  }

  const projects = Object.entries(agg.byProject)
    .sort((a, b) => b[1].calls - a[1].calls)
    .slice(0, 10);
  if (projects.length > 0) {
    console.log();
    console.log('by project (top 10 by calls):');
    console.log(
      `${pad('project', 44)} ${padL('sessions', 8)} ${padL('calls', 8)} ${padL('errors', 7)} ${padL('result-tok', 11)}`
    );
    for (const [id, p] of projects) {
      const name = p.name ?? shortenHome(decodePath(id));
      console.log(
        `${pad(short(name, 44), 44)} ${padL(String(p.sessions), 8)} ${padL(formatTokensCompact(p.calls), 8)} ${padL(String(p.errors), 7)} ${padL(formatTokensCompact(p.resultTokens), 11)}`
      );
    }
  }

  if (opts.byDay) {
    const days = Object.entries(agg.byDay).sort((a, b) => a[0].localeCompare(b[0]));
    if (days.length > 0) {
      console.log();
      console.log('by day:');
      console.log(`${pad('date', 11)} ${padL('calls', 7)}  top tools`);
      for (const [day, dayTools] of days) {
        const total = Object.values(dayTools).reduce((s, v) => s + v, 0);
        const top = Object.entries(dayTools)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([t, n]) => `${t} ${n}`)
          .join(', ');
        console.log(`${pad(day, 11)} ${padL(String(total), 7)}  ${short(top, 60)}`);
      }
    }
  }

  if (agg.outliers.length > 0) {
    console.log();
    console.log(
      `outliers (outside P5–P95 per tool, tools with >= ${MIN_SESSIONS_FOR_OUTLIERS} sessions; top ${Math.min(agg.outliers.length, 20)}):`
    );
    console.log(
      `${pad('scope', 8)} ${pad('where', 34)} ${pad('tool', 20)} ${pad('metric', 13)} ${padL('value', 10)}  band p5..p95`
    );
    // decodePath is lossy on dashed names — the real cwd is the honest label
    const projectCwd = new Map<string, string>();
    for (const s of sessions) {
      if (s.cwd && !projectCwd.has(s.projectId)) projectCwd.set(s.projectId, s.cwd);
    }
    for (const o of agg.outliers.slice(0, 20)) {
      const projectDir = projectCwd.get(o.projectId) ?? shortenHome(decodePath(o.projectId));
      const where =
        o.scope === 'session'
          ? `${short(projectDir, 24)}/${(o.sessionId ?? '').slice(0, 8)}`
          : short(projectDir, 34);
      console.log(
        `${pad(o.scope, 8)} ${pad(where, 34)} ${pad(short(o.tool, 20), 20)} ${pad(o.metric, 13)} ${padL(String(Math.round(o.value)), 10)}  ${Math.round(o.band.p5)}..${Math.round(o.band.p95)}`
      );
    }
  }

  if (opts.sessions && sessions.length > 0) {
    console.log();
    console.log('sessions:');
    console.log(
      `${pad('project', 40)} ${pad('session', 9)} ${pad('date', 11)} ${padL('calls', 7)} ${padL('errors', 7)} ${padL('api-err', 7)} ${padL('result-tok', 11)}`
    );
    for (const s of sortSessions(sessions, opts.sort).slice(0, opts.limit)) {
      const merged = mergeAll(s);
      console.log(
        `${pad(short(s.cwd ? shortenHome(s.cwd) : shortenHome(decodePath(s.projectId)), 40), 40)} ${pad(s.sessionId.slice(0, 8), 9)} ${pad(s.lastTs ? ymd(s.lastTs) : 'n/a', 11)} ${padL(String(merged.calls), 7)} ${padL(String(merged.errors), 7)} ${padL(String(s.apiErrors.count), 7)} ${padL(formatTokensCompact(merged.resultTokens), 11)}`
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log(
      [
        'usage: tool-stats [--project <dir|encoded>] [flags]',
        '',
        'flags:',
        '  --project <dir|encoded>   scan one project instead of all',
        '  --since DATE              only sessions whose last activity is on/after this date (YYYY-MM-DD or YYYYMMDD)',
        '  --until DATE              only sessions whose last activity is on/before this date',
        '  --last N                  sessions whose last activity falls in the last N calendar days',
        '  --day-window N            call-level slice: only calls made in the last N calendar days',
        '  --sort FIELD              calls | errors | tokens | name (default calls)',
        '  --limit N                 show first N rows (default 20)',
        '  --by-day                  per-date call counts',
        '  --sessions                include per-session rows',
        '  --json                    machine-readable output',
      ].join('\n')
    );
    return;
  }
  const opts = parseToolStatsArgs(argv);
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

  const minCallTs =
    opts.dayWindow !== undefined ? lastDaysSince(opts.dayWindow).getTime() : undefined;
  const scanned = await collect(getProjectsBasePath(), projectDir, minCallTs);
  // a call-level slice has no use for sessions without in-window calls
  const withCalls =
    minCallTs !== undefined ? scanned.filter((s) => mergeAll(s).calls > 0) : scanned;
  const hasDateFilter = opts.since !== undefined || opts.until !== undefined;
  // heuristic: a session's date = its LAST activity (same as session-inventory)
  const sessions = withCalls.filter((s) =>
    hasDateFilter ? s.lastTs !== null && inDateRange(s.lastTs, opts.since, opts.until) : true
  );
  if (sessions.length === 0) {
    console.log('no sessions found');
    return;
  }

  const agg = aggregate(sessions);
  if (opts.json) {
    const out: Record<string, unknown> = { ...agg };
    if (opts.sessions) {
      // per-call duration samples are band-working data, not report rows
      out.sessions = sortSessions(sessions, opts.sort).map((s) => ({
        ...s,
        toolDurationsMs: undefined,
      }));
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  printHuman(agg, sessions, opts);
}

// run only when executed directly — vitest imports this file for the pure core
if (isDirectRun(import.meta.url)) {
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
