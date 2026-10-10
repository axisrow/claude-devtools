/**
 * turnSpendStats CLI — corpus calibration for the turn-input budget hook.
 *
 * Walks ~/.claude/projects/** session transcripts with the SAME accounting the
 * turn-budget hook enforces: per turn (from one real user message to the next),
 * sum the input-side tokens (input + cache_read + cache_creation) of every
 * distinct request (streaming/GLM fragments billed once, keep-newest). Prints
 * percentiles so the default budget comes from data, not guesswork. Flags:
 * --p N (percentile to highlight, default 99).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

// same turn-boundary predicate the hook enforces — one definition, no drift
import {
  analyzeTurn,
  billedRequestKey,
  inputSideTokens,
  isMainChainAssistantLine,
  isTurnBoundary,
  isTurnNumberLine,
} from '../../scripts/turn-budget-hook.mjs';

import { takeFlagValue, wantsHelp } from './args';

export interface TurnSpend {
  file: string;
  turnIndex: number;
  inputSide: number;
  rounds: number;
  /** per-request running input side — keep-newest bookkeeping (internal) */
  usageByRequest?: Map<string, number>;
}

/** One JSONL line -> state mutation for the turn-spend walker. */
export function feedLine(
  line: string,
  state: { current: TurnSpend | null; spends: TurnSpend[]; file: string }
): void {
  let msg: {
    type?: string;
    isMeta?: boolean;
    requestId?: string;
    messageId?: string;
    message?: {
      id?: string;
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
  };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  // raw lines wrap content/usage in .message (ParsedMessage flattens it)
  const inner = msg.message ?? {};

  // turn boundary — the hook's own predicate: real user message OR compaction
  // marker, so calibration measures exactly the turns the hook enforces
  if (isTurnBoundary(msg)) {
    if (state.current && state.current.rounds > 0) state.spends.push(state.current);
    state.current = { file: state.file, turnIndex: state.spends.length, inputSide: 0, rounds: 0 };
    return;
  }

  if (isMainChainAssistantLine(msg) && inner.usage && state.current) {
    const side = inputSideTokens(inner.usage);
    const key = billedRequestKey(msg);
    if (key) {
      // keep-newest, same as the hook's newest-first scan: the last line of a
      // streamed request carries the final counts, so it REPLACES the earlier
      // fragment's contribution instead of adding to it
      const usageByRequest = (state.current.usageByRequest ??= new Map<string, number>());
      const prev = usageByRequest.get(key);
      if (prev === undefined) {
        state.current.rounds += 1;
      } else {
        state.current.inputSide -= prev;
      }
      usageByRequest.set(key, side);
      state.current.inputSide += side;
    } else {
      // no request identity — each line is its own request
      state.current.inputSide += side;
      state.current.rounds += 1;
    }
  }
}

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return sorted[idx];
}

// =============================================================================
// CLI
// =============================================================================

/** --audit <file.jsonl>: the three accountings side by side, per turn.
 * Every number shown to a human (hook notification, detector bell, panel
 * Re-read) must come out equal here — divergence is a bug, this prints it. */
async function auditFile(filePath: string): Promise<void> {
  const { sumTurnReread } = await import('../renderer/utils/contextTracker');
  const { TurnBudgetDetector } = await import('../main/utils/loopDetection');

  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
  // ParsedMessage shape for the detector: usage/model/toolCalls at the top
  const flat = lines.map((l) => {
    const m = JSON.parse(l) as Record<string, unknown>;
    const inner = m.message as { usage?: unknown; model?: string } | undefined;
    return { ...m, usage: m.usage ?? inner?.usage, model: inner?.model, toolCalls: [] };
  });

  // turn slices (1-based numbering, the ledger's canon — real user lines via
  // isTurnNumberLine, the same set buildLedger numbers; NOT the bell's
  // turnNumber, which transcript canon and teammate relays advance):
  // turn 1 opens at the FIRST boundary; metadata before it is not a turn.
  // A compaction marker splits the slice but prints the SAME bucket number.
  const slices: string[][] = [];
  const sliceTurnNos: number[] = [];
  let cur: string[] = [];
  let sawBoundary = false;
  let turnNo = 0;
  for (const line of lines) {
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (isTurnBoundary(m)) {
      if (sawBoundary && cur.length) {
        slices.push(cur);
        sliceTurnNos.push(turnNo);
      }
      cur = [];
      sawBoundary = true;
    }
    if (isTurnNumberLine(m)) turnNo += 1;
    if (sawBoundary) cur.push(line);
  }
  if (cur.length) {
    slices.push(cur);
    sliceTurnNos.push(turnNo);
  }

  // detector path (the live bell): line-by-line feed, exactly what FileWatcher
  // streams; snapshot each turn's running total right before its boundary resets
  // the bucket. Batch-feed equivalence is pinned by the parity test.
  const det = new TurnBudgetDetector();
  const detTotals: number[] = [];
  for (const m of flat) {
    const before = det.currentTurnTotal('audit');
    if (isTurnBoundary(m as never)) detTotals.push(before);
    det.feed('audit', [m as never], Number.MAX_SAFE_INTEGER);
  }
  detTotals.push(det.currentTurnTotal('audit'));

  const fmtK = (n: number): string =>
    n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'k' : String(n);
  console.log('turn  start(ts)                analyzeTurn  detector   panelReread  rq');
  let mismatches = 0;
  slices.forEach((slice, i) => {
    const hook = analyzeTurn([...slice].reverse()).spent;
    // detTotals[0] is the pre-first-boundary prefix; turn i (1-based) = [i+1]
    const bell = detTotals[i + 1] ?? 0;
    const panel = sumTurnReread(
      slice
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .filter((m) => m.type === 'assistant')
        .map((m) => ({
          ...m,
          usage: m.usage ?? (m.message as { usage?: unknown } | undefined)?.usage,
          model: (m.message as { model?: string } | undefined)?.model,
          toolCalls: [],
        })) as never[]
    );
    const agree = hook === bell && hook === panel.tokens;
    if (!agree) mismatches++;
    const startTs = (() => {
      try {
        return (JSON.parse(slice[0]) as { timestamp?: string }).timestamp ?? '';
      } catch {
        return '';
      }
    })();
    console.log(
      String(sliceTurnNos[i]).padStart(4),
      startTs.padEnd(24),
      fmtK(hook).padStart(11),
      fmtK(bell).padStart(10),
      fmtK(panel.tokens).padStart(12),
      String(panel.requests).padStart(4),
      agree ? '' : '  <-- MISMATCH'
    );
  });
  console.log(
    mismatches === 0
      ? `parity OK (${slices.length} turns)`
      : `parity BROKEN: ${mismatches}/${slices.length} turns disagree`
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log('Usage: pnpm turn-spend:stats [--p N] | --audit <file.jsonl>');
    return;
  }
  const aIdx = argv.indexOf('--audit');
  if (aIdx !== -1) {
    const { value } = takeFlagValue(argv, aIdx);
    if (!value) {
      console.error('--audit requires a .jsonl path');
      process.exitCode = 1;
      return;
    }
    await auditFile(path.resolve(value));
    return;
  }
  const pIdx = argv.indexOf('--p');
  const p = pIdx !== -1 ? parseFloat(argv[pIdx + 1] ?? '') || 99 : 99;

  const base = path.join(os.homedir(), '.claude', 'projects');
  const spends: TurnSpend[] = [];
  let fileCount = 0;

  for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const projectPath = path.join(base, dir.name);
    let files: fs.Dirent[] = [];
    try {
      files = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl') || f.name.startsWith('agent-')) continue;
      const filePath = path.join(projectPath, f.name);
      const state = { current: null as TurnSpend | null, spends, file: filePath };
      try {
        const rl = readline.createInterface({
          input: fs.createReadStream(filePath),
          crlfDelay: Infinity,
        });
        for await (const line of rl) feedLine(line, state);
      } catch {
        continue;
      }
      if (state.current && state.current.rounds > 0) spends.push(state.current);
      fileCount++;
    }
  }

  const values = spends.map((s) => s.inputSide).sort((a, b) => a - b);
  const fmt = (n: number): string => n.toLocaleString('en-US');
  console.log(`scanned ${fileCount} files, ${values.length} turns`);
  for (const q of [50, 75, 90, 95, 99, 99.9]) {
    console.log(`p${q}: ${fmt(percentile(values, q))}`);
  }
  console.log(`max: ${fmt(values[values.length - 1] ?? 0)}`);
  console.log(`p${p} suggestion: ${fmt(percentile(values, p))}`);

  const buckets = [0, 100_000, 500_000, 1_000_000, 2_000_000, 5_000_000, Infinity];
  const labels = ['<100k', '100-500k', '500k-1M', '1-2M', '2-5M', '5M+'];
  for (let i = 0; i < labels.length; i++) {
    const n = values.filter((v) => v >= buckets[i] && v < buckets[i + 1]).length;
    console.log(
      `${labels[i].padEnd(9)} ${String(n).padStart(6)} (${((n / values.length) * 100).toFixed(1)}%)`
    );
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
