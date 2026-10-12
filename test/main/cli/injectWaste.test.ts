/**
 * Waste injection harness tests (#80) — mini fixtures from #79 stand in for
 * the corpus in CI:
 *  - recall gate: every injectable pattern is found on every fixture with the
 *    exact injected cost (fails if recall of any type drops below 100%);
 *  - mutator plausibility: insertion keeps ledger invariants intact and bills
 *    the injected waste (billed tokens grow);
 *  - scoring: median |err| aggregation.
 * The real-corpus report (`pnpm waste:recall`) prints the same metrics over
 * CORPUS_DIR sessions; the corpus itself never enters the repo.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { buildLedger, computeFindings } from '../../../src/cli/analyzeSession';
import { checkInvariants } from '../../../src/cli/corpus';
import {
  evaluateInjection,
  injectWaste,
  INJECTABLE_TYPES,
  scoreOutcomes,
} from '../../../src/cli/injectWaste';
import { parseJsonlFile } from '../../../src/main/utils/jsonl';

import type { InjectionOutcome } from '../../../src/cli/injectWaste';
import type { ParsedMessage } from '../../../src/main/types';

const FIXTURES_DIR = path.resolve(process.cwd(), 'test/fixtures/corpus');
const fixtures = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith('.jsonl'))
  .sort();

const parseFixture = async (file: string): Promise<ParsedMessage[]> =>
  parseJsonlFile(path.join(FIXTURES_DIR, file));

describe('waste injection (#80) — recall gate on mini fixtures', () => {
  for (const file of fixtures) {
    for (const type of INJECTABLE_TYPES) {
      it(`${file} ← ${type}: found with exact cost, ledger intact`, async () => {
        const messages = await parseFixture(file);

        const inj = injectWaste(type, messages);
        expect(inj).not.toBeNull();
        expect(inj!.expected).toBeGreaterThan(0);

        // mutator plausibility: invariants hold, waste is billed somewhere
        const base = buildLedger(messages);
        const ledger = buildLedger(inj!.messages);
        const findings = computeFindings(inj!.messages, ledger);
        expect(checkInvariants(ledger, findings)).toEqual([]);
        expect(ledger.totals.billedTokens).toBeGreaterThan(base.totals.billedTokens);
        expect(ledger.rounds.length).toBeGreaterThan(base.rounds.length);

        // recall + quantity: detector books exactly the injected amount
        const outcome = evaluateInjection(messages, file).find((o) => o.type === type);
        expect(outcome?.skipped).toBeFalsy();
        expect(outcome?.found).toBe(true); // recall gate — <100% fails here
        expect(outcome?.relError).toBe(0);
        expect(outcome?.booked).toBe(inj!.expected);
      });
    }
  }

  it('a session too small for an insertion point is skipped, not misreported', () => {
    const tiny: ParsedMessage[] = [
      {
        uuid: 'u1',
        parentUuid: null,
        type: 'user',
        timestamp: new Date('2026-10-01T10:00:00Z'),
        content: 'go',
        isSidechain: false,
        isMeta: false,
        toolCalls: [],
        toolResults: [],
      },
    ];
    const outcomes = evaluateInjection(tiny);
    expect(outcomes).toHaveLength(INJECTABLE_TYPES.length);
    expect(outcomes.every((o) => o.skipped === true && o.found === false)).toBe(true);
  });
});

describe('scoreOutcomes — recall and median |err| aggregation', () => {
  const row = (over: Partial<InjectionOutcome>): InjectionOutcome => ({
    type: 'duplicate_call',
    expected: 100,
    found: true,
    booked: 100,
    relError: 0,
    ...over,
  });

  it('median of an even error set is the mean of the middle pair', () => {
    const scores = scoreOutcomes([
      row({ type: 'failed_call', relError: 0.1 }),
      row({ type: 'failed_call', relError: 0.3 }),
      row({ type: 'failed_call', relError: 0.02 }),
      row({ type: 'failed_call', relError: 0.04 }),
    ]);
    const s = scores.find((x) => x.type === 'failed_call');
    expect(s?.recall).toBe(1);
    expect(s?.medianRelError).toBeCloseTo(0.07);
  });

  it('missed injections cut recall; skipped rows leave attempts untouched', () => {
    const scores = scoreOutcomes([
      row({ type: 'cache_dead', found: false, booked: null, relError: null }),
      row({ type: 'cache_dead', relError: 0.5 }),
      row({ type: 'oversized_output', skipped: true, found: false, booked: null, relError: null }),
    ]);
    expect(scores.find((x) => x.type === 'cache_dead')?.recall).toBe(0.5);
    expect(scores.find((x) => x.type === 'oversized_output')?.attempts).toBe(0);
    expect(scores.find((x) => x.type === 'oversized_output')?.recall).toBeNull();
  });
});
