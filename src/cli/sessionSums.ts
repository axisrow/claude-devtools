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
import {
  analyzeTurn,
  billedRequestKey,
  inputSideTokens,
  isMainChainAssistantLine,
  isTurnBoundary,
  isTurnNumberLine,
} from '@shared/turnAccounting';
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

/** usage object of a raw assistant line — typed access into untyped JSON. */
function usageOfRaw(m: Record<string, unknown>): Parameters<typeof inputSideTokens>[0] | undefined {
  const message = m.message as { usage?: Parameters<typeof inputSideTokens>[0] } | undefined;
  return message?.usage;
}

/** Rounds summed straight from raw lines: canonical primitives
 * (isMainChainAssistantLine + billedRequestKey + inputSideTokens), the same
 * arithmetic analyzeTurn bills under. Per billedRequestKey the LAST raw line
 * wins — deduplicateByRequestId merges into `{...last}`, so the checksum side
 * must keep the newest counts too. Independent of ledger.rounds, so the rounds
 * checksum actually fails when rounds drift (#102). */
function roundsInputSideFromRaw(rawLines: string[]): { inputSide: number; output: number } {
  const byKey = new Map<string, { inputSide: number; output: number }>();
  let inputSide = 0;
  let output = 0;
  for (const line of rawLines) {
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const u = usageOfRaw(m);
    if (!isMainChainAssistantLine(m) || !u) continue;
    const key = billedRequestKey(m);
    if (key) {
      // keep-last: a key's final line carries the final usage counts
      byKey.set(key, { inputSide: inputSideTokens(u), output: u.output_tokens ?? 0 });
      continue;
    }
    // keyless lines bill individually (analyzeTurn sums them every time)
    inputSide += inputSideTokens(u);
    output += u.output_tokens ?? 0;
  }
  for (const v of byKey.values()) {
    inputSide += v.inputSide;
    output += v.output;
  }
  return { inputSide, output };
}

/** Pure rollup: ledger + findings + per-turn hook spend + raw lines →
 * JSON-ready shape. Raw lines back the rounds checksum so it compares an
 * independently counted sum, not a sum with itself. */
export function buildSums(
  ledger: SessionLedger,
  findings: Finding[],
  hookSpent: Map<number, number>,
  rawLines: string[]
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
  // rounds side counted straight from raw lines (canonical primitives,
  // whole-session requestId dedup — mirroring deduplicateByRequestId) so
  // drift in ledger.rounds cannot pass unnoticed
  const rawRounds = roundsInputSideFromRaw(rawLines);
  const roundsEqualTurns =
    rawRounds.inputSide === turnsInputSide && rawRounds.output === turnsOutput;
  // two-sided hook parity: union of ledger turn indexes and hook turn numbers
  const inputSideByTurn = new Map(turns.map((tn) => [tn.index, tn.inputSide]));
  const hookMismatches = [...new Set([...inputSideByTurn.keys(), ...hookSpent.keys()])]
    .sort((a, b) => a - b)
    .filter((no) => (inputSideByTurn.get(no) ?? 0) !== (hookSpent.get(no) ?? 0))
    .map((no) => ({
      turn: no,
      ledger: inputSideByTurn.get(no) ?? 0,
      hook: hookSpent.get(no) ?? 0,
    }));
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
 * slices, like turnSpendStats), number segments by isTurnNumberLine (compact
 * keeps the current number), sum analyzeTurn per number.
 *
 * Numbering mirrors buildLedger (#102): assistant rounds before the first user
 * message open the implicit turn 1, each real user message opens the next —
 * hook and ledger numbers then name the same turns. Segments accumulate from
 * the first line, so the implicit turn's spend is counted too. */
export function hookSpentByTurn(rawLines: string[]): Map<number, number> {
  const spent = new Map<number, number>();
  const add = (no: number, lines: string[]): void => {
    if (lines.length === 0 || no === 0) return; // turn 0 never bills: first billed round opens turn 1
    const { spent: s } = analyzeTurn([...lines].reverse());
    spent.set(no, (spent.get(no) ?? 0) + s);
  };
  let turnNo = 0; // 0 = before any turn; bumped to 1 by the implicit-turn rule
  let cur: string[] = [];
  for (const line of rawLines) {
    let m: Record<string, unknown> = {};
    try {
      m = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // implicit ledger turn: first billed main-chain assistant round before any
    // user message — the same condition analyzeTurn bills under
    if (turnNo === 0 && isMainChainAssistantLine(m) && usageOfRaw(m)) turnNo = 1;
    if (isTurnBoundary(m)) {
      add(turnNo, cur);
      cur = [];
    }
    if (isTurnNumberLine(m)) turnNo = turnNo === 0 ? 1 : turnNo + 1;
    cur.push(line);
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
  const sums = buildSums(ledger, findings, hookSpentByTurn(rawLines), rawLines);
  console.log(JSON.stringify({ ...splitSessionPath(file), ...sums }, null, 2));
}
if (isDirectRun(import.meta.url)) {
  void main();
}
