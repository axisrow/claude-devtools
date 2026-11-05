/**
 * subagent-scan CLI — per-subagent transcript accounting across ~/.claude/projects.
 *
 * The runaway-subagent problem: a background subagent (Task tool / AO worker)
 * spins for 1–2 hours burning tokens while nobody watches — every live
 * detector in the app (stall/loop/turn-budget/silence) explicitly excludes
 * subagent transcripts. This CLI is the measurement + live-check half of the
 * catch: it scans every subagent transcript the corpus defines (new nested
 * layout + wf_* nesting, via toolStats' listSessionFiles; old flat
 * agent-*.jsonl is excluded there because it duplicates the parent's
 * embedded sidechain) and reports per file:
 *   rounds     billed requests (request-identity dedup via the canon ledger,
 *              so GLM mixed-shape heads+fragments count once)
 *   in / out   request-deduped input-side and output tokens
 *   span       first→last line timestamp; NOW marks a file touched within
 *              --active-minutes (still spinning)
 *
 * Doubles as the threshold-data source for the in-app subagent watch: run it
 * over the corpus, read the minutes/tokens ladders, pick the bell thresholds.
 *
 * Usage:
 *   subagent-scan [--project <dir|encoded>] [flags]
 * Flags:
 *   --project <dir|encoded>  scan one project instead of all
 *   --top N                  rows per table (default 20)
 *   --active-minutes N       "NOW" window for still-growing files (default 10)
 *   --json                   machine-readable output
 */

import { getProjectsBasePath } from '@main/utils/pathDecoder';
import { createRequestLedger, inputSideTokens } from '@shared/turnAccounting';
import { formatTokensCompact } from '@shared/utils/tokenFormatting';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { dur, pad, padL, resolveProjectDir, short } from './analyzeSession';
import { isDirectRun, takeFlagValue, wantsHelp } from './args';
import { mapWithConcurrency } from './sessionInventory';
import { listSessionFiles } from './toolStats';

// =============================================================================
// Types
// =============================================================================

interface RunLine {
  timestamp?: string;
  type?: string;
  sessionId?: string;
  requestId?: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      output_tokens?: number;
    };
  };
}

export interface SubagentRunStats {
  rounds: number;
  inputSide: number;
  output: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
  lines: number;
  /** sessionId from the transcript lines (parent ownership); null if absent */
  parentSessionId: string | null;
  /** last line touched within the active window of `nowMs` — still spinning */
  ongoing: boolean;
}

export interface SubagentScanOpts {
  nowMs?: number;
  /** "NOW" window in ms (default 10 min) */
  activeMs?: number;
}

export interface SubagentRow {
  project: string;
  parent: string;
  agent: string;
  filePath: string;
  minutes: number;
  rounds: number;
  inputSide: number;
  output: number;
  firstTsMs: number | null;
  lastTsMs: number | null;
  ongoing: boolean;
  lines: number;
}

export interface SubagentScanArgs {
  projectArg?: string;
  top: number;
  activeMinutes: number;
  json: boolean;
  error?: string;
}

// =============================================================================
// Per-file scan (streaming, single pass)
// =============================================================================

export async function scanSubagentFile(
  filePath: string,
  opts: SubagentScanOpts = {}
): Promise<SubagentRunStats> {
  const nowMs = opts.nowMs ?? Date.now();
  const activeMs = opts.activeMs ?? 10 * 60_000;
  // two ledgers, one per currency: request identity is keyed identically, so
  // rounds can be taken from either bill()'s new-key event
  const side = createRequestLedger();
  const out = createRequestLedger();
  let lines = 0;
  let firstTsMs: number | null = null;
  let lastTsMs: number | null = null;
  let parentSessionId: string | null = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let e: RunLine;
    try {
      e = JSON.parse(line) as RunLine;
    } catch {
      continue;
    }
    lines++;
    if (parentSessionId === null && typeof e.sessionId === 'string') {
      parentSessionId = e.sessionId;
    }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (firstTsMs === null || ts < firstTsMs) firstTsMs = ts;
      if (lastTsMs === null || ts > lastTsMs) lastTsMs = ts;
    }
    if (e.type === 'assistant' && e.message?.usage) {
      const sideAmt = inputSideTokens(e.message.usage);
      const outAmt = e.message.usage.output_tokens ?? 0;
      side.bill(e, sideAmt, true);
      out.bill(e, outAmt, true);
    }
  }
  const ongoing = lastTsMs !== null && nowMs - lastTsMs <= activeMs;
  return {
    rounds: side.keys,
    inputSide: side.spent,
    output: out.spent,
    firstTsMs,
    lastTsMs,
    lines,
    parentSessionId,
    ongoing,
  };
}

// =============================================================================
// Corpus walk
// =============================================================================

export async function collectSubagentRuns(
  projectsRoot: string,
  opts: { projectArg?: string; nowMs?: number; activeMs?: number } = {}
): Promise<{ rows: SubagentRow[]; scannedFiles: number }> {
  let dirs: string[];
  if (opts.projectArg) {
    dirs = [opts.projectArg];
  } else {
    const es = await fs.promises.readdir(projectsRoot, { withFileTypes: true });
    dirs = es.filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
  }

  const groups = await mapWithConcurrency(dirs, 8, listSessionFiles);
  const jobs: { file: string; project: string }[] = [];
  for (const g of groups) {
    if (!g) continue;
    for (const f of g.subagentFiles) {
      // project from the file's own path — mapWithConcurrency returns group
      // results in completion order, so indexing groups by dir would
      // mislabel every row under concurrency
      jobs.push({
        file: f,
        project: path.relative(projectsRoot, f).split(path.sep)[0] ?? '?',
      });
    }
  }

  // carry the job through the task: mapWithConcurrency returns results in
  // completion order, so stats[i] would pair with a foreign job once scans
  // finish out of order (same trap the groups walk above already avoids)
  const pairs = await mapWithConcurrency(jobs, 8, async (j) => ({
    j,
    s: await scanSubagentFile(j.file, opts),
  }));
  const rows: SubagentRow[] = [];
  for (const p of pairs) {
    if (!p?.s) continue;
    const { j, s } = p;
    const base = path.basename(j.file, '.jsonl');
    // nested layout <proj>/<sess>/subagents/agent-<id>.jsonl — parent from the
    // path first: transcript lines may carry a STALE sessionId (session
    // resumed/moved; the champion file's lines point at another session than
    // the dir it lives in), while the path is where the app shows it
    const parts = j.file.split(path.sep);
    const parentFromPath =
      parts.length >= 3 && parts[parts.length - 2] === 'subagents' ? parts[parts.length - 3] : null;
    rows.push({
      project: j.project,
      parent: parentFromPath ?? s.parentSessionId ?? '?',
      agent: base,
      filePath: j.file,
      minutes:
        s.firstTsMs !== null && s.lastTsMs !== null
          ? Math.round((s.lastTsMs - s.firstTsMs) / 60000)
          : 0,
      rounds: s.rounds,
      inputSide: s.inputSide,
      output: s.output,
      firstTsMs: s.firstTsMs,
      lastTsMs: s.lastTsMs,
      ongoing: s.ongoing,
      lines: s.lines,
    });
  }
  return { rows, scannedFiles: jobs.length };
}

// =============================================================================
// Output
// =============================================================================

const byMinutes = (a: SubagentRow, b: SubagentRow): number =>
  b.minutes - a.minutes || b.inputSide + b.output - (a.inputSide + a.output);
const byBurn = (a: SubagentRow, b: SubagentRow): number =>
  b.inputSide + b.output - (a.inputSide + a.output) || b.minutes - a.minutes;

function printHuman(
  rows: SubagentRow[],
  opts: SubagentScanArgs,
  root: string,
  scanned: number
): void {
  const spinning = rows.filter((r) => r.ongoing);
  console.log(`subagent-scan  active>=${opts.activeMinutes}m=NOW  corpus: ${root}`);
  console.log(
    `scanned ${scanned} subagent files · spinning now: ${spinning.length} · Σ rounds ${rows.reduce((s, r) => s + r.rounds, 0)} · Σ in ${formatTokensCompact(rows.reduce((s, r) => s + r.inputSide, 0))} · Σ out ${formatTokensCompact(rows.reduce((s, r) => s + r.output, 0))}`
  );
  if (rows.length === 0) return;

  const header = `${pad('PROJECT', 26)}${pad('SESSION', 10)}${pad('AGENT', 22)}${padL('SPAN', 9)}${padL('ROUNDS', 7)}${padL('IN', 10)}${padL('OUT', 10)}  NOW`;
  const rowLine = (r: SubagentRow): string =>
    [
      pad(short(r.project, 24), 26),
      pad(short(r.parent, 8), 10),
      pad(short(r.agent, 20), 22),
      padL(dur(r.minutes * 60000), 9),
      padL(String(r.rounds), 7),
      padL(r.inputSide > 0 ? formatTokensCompact(r.inputSide) : '—', 10),
      padL(r.output > 0 ? formatTokensCompact(r.output) : '—', 10),
      r.ongoing ? '  ←NOW' : '',
    ].join('');

  console.log('');
  console.log(`top by span (of ${rows.length}):`);
  console.log(header);
  for (const r of [...rows].sort(byMinutes).slice(0, opts.top)) console.log(rowLine(r));

  console.log('');
  console.log(`top by burn (in+out):`);
  console.log(header);
  for (const r of [...rows].sort(byBurn).slice(0, opts.top)) console.log(rowLine(r));

  // threshold ladders — the data the in-app watch's minutes/tokens come from
  const ladder = (title: string, xs: number[], steps: number[]): void => {
    const cells = steps.map((t) => `>${t} ${xs.filter((x) => x > t).length}`);
    console.log(`${title}: ${cells.join(' | ')}`);
  };
  console.log('');
  ladder(
    'span ladder (files)',
    rows.map((r) => r.minutes),
    [10, 30, 60, 120]
  );
  ladder(
    'burn ladder (in+out, Mtok)',
    rows.map((r) => (r.inputSide + r.output) / 1e6),
    [1, 5, 10, 50]
  );
}

// =============================================================================
// Args + entry
// =============================================================================

const USAGE = `subagent-scan — per-subagent transcript accounting over ~/.claude/projects
Flags:
  --project <dir|encoded>  scan one project instead of all
  --top N                  rows per table (default 20)
  --active-minutes N       "NOW" window for still-growing files (default 10)
  --json                   machine-readable output`;

export function parseSubagentScanArgs(argv: string[]): SubagentScanArgs {
  const opts: SubagentScanArgs = { top: 20, activeMinutes: 10, json: false };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const { value, next } = takeFlagValue(argv, i);
    if (a === '--project') {
      opts.projectArg = value;
      i = next;
      continue;
    }
    if (a === '--top') {
      const n = parseInt(value, 10);
      opts.top = n > 0 ? n : 20;
      i = next;
      continue;
    }
    if (a === '--active-minutes') {
      if (/^[1-9]\d*$/.test(value)) {
        opts.activeMinutes = parseInt(value, 10);
      } else {
        opts.error = `--active-minutes expects minutes >= 1, got '${value || '(missing)'}'`;
      }
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
  const opts = parseSubagentScanArgs(argv);
  if (opts.error) {
    console.error(opts.error);
    process.exitCode = 1;
    return;
  }
  const root = getProjectsBasePath();
  const projectArg = opts.projectArg ? resolveProjectDir(opts.projectArg) : undefined;
  const { rows, scannedFiles } = await collectSubagentRuns(root, {
    projectArg,
    activeMs: opts.activeMinutes * 60000,
  });
  if (opts.json) {
    console.log(JSON.stringify({ root, scannedFiles, rows }, null, 2));
    return;
  }
  printHuman(rows, opts, root, scannedFiles);
}

if (isDirectRun(import.meta.url))
  void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
