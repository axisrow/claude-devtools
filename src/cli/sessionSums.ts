/**
 * session:sums — machine-readable token rollup: session → turns → rounds,
 * with checksums and cycle attribution. Turns carry both the ledger sums
 * (per-round, requestId-deduped) and the hook's own analyzeTurn spend
 * (keep-newest input-side) so the numbers can be checked against the GUI
 * panel and the bell in one place.
 *
 * Usage: pnpm session:sums <path-to.jsonl>   (JSON on stdout, raw numbers)
 */
import { parseJsonlFile } from '@main/utils/jsonl';
import { analyzeTurn, isTurnBoundary, isTurnNumberLine } from '@shared/turnAccounting';
import * as fs from 'fs';

import {
  buildLedger,
  computeFindings,
  type Finding,
  type SessionLedger,
  splitSessionPath,
  turnVerdict,
} from './analyzeSession';
import { isDirectRun } from './args';

interface RollupRound {
  index: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  inputSide: number;
  billedTotal: number;
}

const CYCLE_TYPES = new Set(['cycle_motif', 'probe_no_progress']);

/** Pure rollup: ledger + findings + per-turn hook spend → JSON-ready shape. */
export function buildSums(
  ledger: SessionLedger,
  findings: Finding[],
  hookSpent: Map<number, number>
): Record<string, unknown> {
  const roundRollup = (r: {
    index: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
  }): RollupRound => ({
    index: r.index,
    input: r.inputTokens,
    cacheRead: r.cacheReadTokens,
    cacheWrite: r.cacheCreationTokens,
    output: r.outputTokens,
    inputSide: r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens,
    billedTotal: r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens + r.outputTokens,
  });

  const roundsByTurn = new Map<number, ReturnType<typeof roundRollup>[]>();
  for (const r of ledger.rounds) {
    const list = roundsByTurn.get(r.turnIndex);
    const roll = roundRollup(r);
    if (list) list.push(roll);
    else roundsByTurn.set(r.turnIndex, [roll]);
  }
  const findingsByTurn = new Map<number, Finding[]>();
  for (const f of findings) {
    if (f.turnIndex === undefined) continue;
    const list = findingsByTurn.get(f.turnIndex);
    if (list) list.push(f);
    else findingsByTurn.set(f.turnIndex, [f]);
  }

  let turnsInputSide = 0;
  let turnsOutput = 0;
  const turns = ledger.turns.map((t) => {
    const rs = roundsByTurn.get(t.index) ?? [];
    const inputSide = rs.reduce((s, r) => s + r.inputSide, 0);
    const output = rs.reduce((s, r) => s + r.output, 0);
    turnsInputSide += inputSide;
    turnsOutput += output;
    const tf = findingsByTurn.get(t.index) ?? [];
    const cycleTypes = tf.filter((f) => CYCLE_TYPES.has(f.type)).map((f) => f.type);
    return {
      index: t.index,
      rounds: rs.length,
      activeMinutes: t.activeMinutes,
      inputSide,
      output,
      billedTotal: inputSide + output,
      hookSpent: hookSpent.get(t.index) ?? 0,
      cycles: {
        verdict: turnVerdict(tf, rs.length, t.activeMinutes),
        tokensWasted: tf
          .filter((f) => CYCLE_TYPES.has(f.type))
          .reduce((s, f) => s + f.tokensWasted, 0),
        types: cycleTypes,
      },
    };
  });

  const t = ledger.totals;
  const sessionInputSide = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
  const sessionBilled = sessionInputSide + t.outputTokens;
  const roundsEqualTurns = turns.every((tn) => {
    const rs = roundsByTurn.get(tn.index) ?? [];
    return (
      rs.reduce((s, r) => s + r.inputSide, 0) === tn.inputSide &&
      rs.reduce((s, r) => s + r.output, 0) === tn.output
    );
  });
  const hookMismatches = turns
    .filter((tn) => tn.inputSide !== tn.hookSpent)
    .map((tn) => ({ turn: tn.index, ledger: tn.inputSide, hook: tn.hookSpent }));
  // «сколько сожжено циклами»: вся inputSide ходов с cycle-вердиктом —
  // консервативная оценка сверху (в re-read валюте бюджета), не штраф находок
  const cycleWasted = turns.reduce(
    (s, tn) => (tn.cycles.verdict.startsWith('cycle-') ? s + tn.inputSide : s),
    0
  );

  return {
    session: {
      input: t.inputTokens,
      cacheRead: t.cacheReadTokens,
      cacheWrite: t.cacheCreationTokens,
      output: t.outputTokens,
      inputSide: sessionInputSide,
      billedTotal: sessionBilled,
    },
    turns,
    checksums: {
      roundsSumEqualsTurnsSum: roundsEqualTurns,
      turnsSumEqualsSession: turnsInputSide === sessionInputSide && turnsOutput === t.outputTokens,
      hookParity: { match: hookMismatches.length === 0, mismatches: hookMismatches },
    },
    tragedy: {
      cycleTokensWasted: cycleWasted,
      cycleTurns: turns.filter((tn) => tn.cycles.verdict.startsWith('cycle-')).length,
      shareOfSession: sessionBilled > 0 ? cycleWasted / sessionBilled : 0,
    },
  };
}

/** Hook accounting per turn: split raw lines at isTurnBoundary (chronological
 * slices, like turnSpendStats), number slices by isTurnNumberLine (compact
 * keeps the current number), sum analyzeTurn per number. */
export function hookSpentByTurn(rawLines: string[]): Map<number, number> {
  const spent = new Map<number, number>();
  const add = (no: number, lines: string[]): void => {
    if (lines.length === 0) return;
    const { spent: s } = analyzeTurn([...lines].reverse());
    spent.set(no, (spent.get(no) ?? 0) + s);
  };
  let turnNo = 0;
  let cur: string[] = [];
  let sawBoundary = false;
  for (const line of rawLines) {
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (isTurnBoundary(m)) {
      if (sawBoundary) add(turnNo, cur);
      cur = [];
      sawBoundary = true;
    }
    if (isTurnNumberLine(m)) turnNo += 1;
    if (sawBoundary) cur.push(line);
  }
  add(turnNo, cur);
  return spent;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('usage: pnpm session:sums <path-to.jsonl>');
    process.exitCode = 1;
    return;
  }
  const messages = await parseJsonlFile(file);
  const ledger = buildLedger(messages);
  const findings = computeFindings(messages, ledger);
  const rawLines = fs.readFileSync(file, 'utf8').split('\n');
  const sums = buildSums(ledger, findings, hookSpentByTurn(rawLines));
  console.log(JSON.stringify({ ...splitSessionPath(file), ...sums }, null, 2));
}
if (isDirectRun(import.meta.url)) {
  void main();
}
