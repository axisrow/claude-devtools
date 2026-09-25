/**
 * turnSpendStats CLI — corpus calibration for the turn-input budget hook.
 *
 * Walks ~/.claude/projects/** session transcripts with the SAME accounting the
 * turn-budget hook enforces: per turn (from one real user message to the next),
 * sum the input-side tokens (input + cache_read + cache_creation) of every
 * assistant round. Prints percentiles so the default budget comes from data,
 * not guesswork. Flags: --p N (percentile to highlight, default 99).
 */

import { isParsedUserChunkMessage } from '@main/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

import { wantsHelp } from './args';

export interface TurnSpend {
  file: string;
  turnIndex: number;
  inputSide: number;
  rounds: number;
}

/** One JSONL line -> state mutation for the turn-spend walker. */
export function feedLine(
  line: string,
  state: { current: TurnSpend | null; spends: TurnSpend[]; file: string }
): void {
  let msg: {
    type?: string;
    isMeta?: boolean;
    message?: {
      usage?: {
        input_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      content?: unknown;
    };
  };
  try {
    msg = JSON.parse(line) as typeof msg;
  } catch {
    return;
  }
  // raw lines wrap content/usage in .message (ParsedMessage flattens it)
  const inner = msg.message ?? {};

  // real user message = turn boundary — same predicate as analyzeSession
  if (
    isParsedUserChunkMessage({
      type: msg.type,
      isMeta: msg.isMeta,
      content: inner.content,
    } as never)
  ) {
    if (state.current && state.current.rounds > 0) state.spends.push(state.current);
    state.current = { file: state.file, turnIndex: state.spends.length, inputSide: 0, rounds: 0 };
    return;
  }

  if (msg.type === 'assistant' && inner.usage && state.current) {
    const u = inner.usage;
    state.current.inputSide +=
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0);
    state.current.rounds += 1;
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (wantsHelp(argv)) {
    console.log('Usage: pnpm turn-spend:stats [--p N]');
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
