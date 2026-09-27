/**
 * Golden parity test — the whole point of the single-source-of-truth
 * redesign: one transcript fixture, three consumers, ONE set of numbers.
 *
 * Consumers under parity:
 *  - hook analyzeTurn (scripts/turn-accounting.mjs) — scans newest-first
 *  - calibration feedLine (src/cli/turnSpendStats.ts) — walks forward
 *  - renderer sumTurnReread (src/renderer/utils/contextTracker.ts)
 *
 * The fixture pins: GLM stream fragments (same requestId, full usage each),
 * Claude stream snapshots (same requestId, growing output), a keyless
 * assistant line (own request), a sidechain round (counted — no sidechain
 * filter in this accounting), a ghost line WITHOUT usage (skipped), junk
 * usage fields (ignored), and all the non-boundary user-line shapes
 * (teammate, interrupt, isMeta tool_result) plus the current boundary canon
 * (<local-command-stdout> IS a boundary).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeTurn } from '../../scripts/turn-budget-hook.mjs';
import { feedLine } from '../../src/cli/turnSpendStats';
import { sumTurnReread } from '../../src/renderer/utils/contextTracker';

interface Spend {
  inputSide: number;
  rounds: number;
  file: string;
  turnIndex: number;
}

function mkState() {
  return {
    current: null as Spend | null,
    spends: [] as Spend[],
    file: 'fixture',
  };
}

// vitest runs from the repo root — import.meta.url is not file:// here
const fixturePath = resolve(process.cwd(), 'test/fixtures/turn-accounting/session.jsonl');
const lines = readFileSync(fixturePath, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');

function flatten(
  m: Record<string, unknown> & {
    message?: { usage?: Record<string, number> };
    usage?: Record<string, number>;
  }
): Record<string, unknown> {
  return { ...m, usage: m.usage ?? m.message?.usage };
}

describe('turn accounting — golden parity across consumers', () => {
  it('feedLine (forward) and analyzeTurn (newest-first) agree per turn', () => {
    const state = mkState();
    for (const line of lines) feedLine(line, state);
    const spends = state.spends as { inputSide: number; rounds: number }[];

    // the walk leaves the LAST turn in state.current (no EOF flush) —
    // analyzeTurn scanning newest-first must agree with exactly that turn
    expect(analyzeTurn([...lines].reverse())).toEqual({ spent: 110_000, boundaryFound: true });
    expect(state.current as { inputSide: number } | null).toMatchObject({ inputSide: 110_000 });
    expect(spends[spends.length - 1].inputSide).toBe(102_320);
  });

  it('pins the fixture numbers: 4 turns, fragment dedup, sidechain counted', () => {
    const state = mkState();
    for (const line of lines) feedLine(line, state);
    const spends = state.spends as { inputSide: number; rounds: number }[];

    expect(spends).toHaveLength(4);
    expect(spends.map((s) => s.inputSide)).toEqual([311_800, 4_400, 10_798, 102_320]);
    expect(spends.map((s) => s.rounds)).toEqual([4, 1, 2, 2]);
  });

  it('sumTurnReread (renderer) matches the hook on the same requests', () => {
    // turn 1 = fixture lines 2..8: GLM fragments, snapshots, keyless, sidechain
    const turn1Responses = lines
      .slice(1, 8)
      .map((l) => flatten(JSON.parse(l)))
      .filter((m) => m.type === 'assistant');
    const reread = sumTurnReread(turn1Responses as never[]);
    expect(reread.tokens).toBe(311_800);
    expect(reread.requests).toBe(4);
  });
});
