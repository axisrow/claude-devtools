/**
 * Baseline comparison tests (#85) — does the waste rules' $ beat the naive
 * "top 10% rounds by input tokens" baseline?
 *
 * The synthetic session below has a hand-computed answer: sonnet-5 pricing
 * (in 2 / out 10 / cr 0.2 / cw 2.5 $/MTok), router-style rounds (cr only),
 * one wait_loop booking 5 ticks x 60k tok. Every $ in the expectations is
 * derived from the price row, not from the code under test.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  aggregateBaseline,
  baselineSession,
  MIN_PRICED_SESSIONS,
  pickTopRounds,
  quantile,
} from '../../../src/cli/baseline';
import { buildLedger, computeFindings } from '../../../src/cli/analyzeSession';
import type { Finding, RoundRow } from '../../../src/cli/analyzeSession';
import type { ParsedMessage } from '../../../src/main/types';

let seq = 0;
function makeMsg(
  overrides: Partial<ParsedMessage> & { type: ParsedMessage['type'] }
): ParsedMessage {
  return {
    uuid: `u${++seq}`,
    parentUuid: null,
    timestamp: new Date('2026-09-20T10:00:00Z'),
    content: '',
    toolCalls: [],
    toolResults: [],
    isSidechain: false,
    isMeta: false,
    ...overrides,
  };
}

const usage = (input: number, cr: number, cw: number, out: number) => ({
  input_tokens: input,
  output_tokens: out,
  cache_read_input_tokens: cr,
  cache_creation_input_tokens: cw,
});

afterEach(async () => {
  seq = 0;
});

// =============================================================================
// The known-answer synthetic session
// =============================================================================

const call = (id: string, name: string, input: Record<string, unknown>) => ({
  id,
  name,
  input,
  isTask: false,
});
const result = (toolUseId: string, content: string) => ({
  type: 'tool_result' as const,
  tool_use_id: toolUseId,
  content,
});
const carrier = (at: string, ...rs: ReturnType<typeof result>[]): ParsedMessage =>
  makeMsg({
    type: 'user',
    isMeta: true,
    timestamp: new Date(at),
    content: rs as never,
    toolResults: rs.map((r) => ({
      toolUseId: r.tool_use_id,
      content: r.content,
      isError: false,
    })),
  });
const assistant = (
  at: string,
  cr: number,
  out: number,
  tools: ReturnType<typeof call>[] = []
): ParsedMessage =>
  makeMsg({
    type: 'assistant',
    model: 'claude-sonnet-5-5',
    requestId: `req-${seq}-${at}`,
    timestamp: new Date(at),
    usage: usage(0, cr, 0, out),
    toolCalls: tools,
  });

/** 10 rounds, one wait_loop (turn 1, ticks R2–R6 at 60k), top round = R7 (85k) */
function syntheticSession(): ParsedMessage[] {
  return [
    makeMsg({ type: 'user', content: 'turn one', timestamp: new Date('2026-10-05T10:00:00Z') }),
    assistant('2026-10-05T10:00:05Z', 60000, 200, [
      call('c1', 'Read', { file_path: '/tmp/a.txt' }),
    ]),
    carrier('2026-10-05T10:00:08Z', result('c1', 'data-1')),
    assistant('2026-10-05T10:00:10Z', 60000, 100),
    assistant('2026-10-05T10:00:15Z', 60000, 100),
    assistant('2026-10-05T10:00:20Z', 60000, 100),
    assistant('2026-10-05T10:00:25Z', 60000, 100),
    assistant('2026-10-05T10:00:30Z', 60000, 100),
    makeMsg({ type: 'user', content: 'turn two', timestamp: new Date('2026-10-05T10:01:00Z') }),
    assistant('2026-10-05T10:01:05Z', 90000, 200, [call('c7', 'Bash', { command: 'make-report' })]),
    carrier('2026-10-05T10:01:08Z', result('c7', 'x'.repeat(400))),
    assistant('2026-10-05T10:01:10Z', 90000, 100),
    assistant('2026-10-05T10:01:15Z', 90000, 100, [call('c9', 'Bash', { command: 'ls' })]),
    carrier('2026-10-05T10:01:17Z', result('c9', 'file.txt')),
    assistant('2026-10-05T10:01:20Z', 90000, 100),
  ];
}

// hand-derived from the sonnet-5 price row (2/10/0.2/2.5 $/MTok):
// R1 0.014, ticks 5×0.013, R7 0.020, R8–R10 3×0.019 → cost 0.156
const SYNTH_COST = 0.156;
// wait_loop books 5 ticks × 60000 tok × 0.2 $/MTok = 0.06
const SYNTH_RULES_USD = 0.06;
// top = R7 alone (90k is the largest context; R8–R10 tie but lose on index)
const SYNTH_BASELINE_USD = 0.02;
// results: 'data-1' (2 tok @4.1e-6), 'x'×400 (100 tok @2.9e-6), 'file.txt' (2 tok @2.5e-6)
const SYNTH_B2_VOLUME = 104;
const SYNTH_B2_USD = 2 * 4.1e-6 + 100 * 2.9e-6 + 2 * 2.5e-6;

const approx = (x: number, y: number): boolean => Math.abs(x - y) < 1e-9;

describe('pickTopRounds', () => {
  const round = (index: number, contextSize: number): RoundRow =>
    ({ index, contextSize }) as unknown as RoundRow;

  it('picks ceil(10%) with at least one round, largest first, ties by lower index', () => {
    expect(pickTopRounds([], 0.1)).toEqual([]);
    const rounds = [round(1, 100), round(2, 500), round(3, 500), round(4, 200)];
    // ceil(4 × 0.1) = 1 → the 500 tie resolves to round 2 (lower index)
    expect(pickTopRounds(rounds, 0.1).map((r) => r.index)).toEqual([2]);
    // ceil(25 × 0.1) = 3
    const many = Array.from({ length: 25 }, (_, i) => round(i + 1, 1000 - i));
    expect(pickTopRounds(many, 0.1).map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it('ghost rounds (contextSize 0) are never expensive', () => {
    const rounds = [round(1, 0), round(2, 10)];
    expect(pickTopRounds(rounds, 0.1).map((r) => r.index)).toEqual([2]);
  });
});

describe('quantile', () => {
  it('linear interpolation, median of odd/even', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12);
    expect(quantile([7], 0.9)).toBe(7);
  });
});

describe('sources plumbing (withSources)', () => {
  it('default: findings carry no sources and are byte-identical to before', () => {
    const messages = syntheticSession();
    const ledger = buildLedger(messages);
    const plain = computeFindings(messages, ledger);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.every((f) => f.sources === undefined)).toBe(true);
    const withSrc = computeFindings(messages, ledger, undefined, undefined, true);
    expect(JSON.stringify(withSrc.map(({ sources: _s, ...f }) => f))).toBe(JSON.stringify(plain));
  });

  it('withSources: Σ sources = tokensWasted / wastedUsd (wait_loop on rounds 2–6)', () => {
    const messages = syntheticSession();
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger, undefined, undefined, true);
    const wait = findings.find((f) => f.type === 'wait_loop');
    expect(wait?.sources).toHaveLength(5);
    expect(wait?.sources?.map((s) => s.round)).toEqual([2, 3, 4, 5, 6]);
    expect(wait?.sources?.reduce((a, s) => a + s.tokens, 0)).toBe(300000);
    expect(wait?.sources?.reduce((a, s) => a + (s.usd ?? 0), 0)).toBeCloseTo(SYNTH_RULES_USD, 12);
    // allocation guarantees hold for every claim-based finding
    for (const f of findings) {
      if (!f.sources) continue;
      expect(f.sources.reduce((a, s) => a + s.tokens, 0)).toBe(f.tokensWasted);
      if (f.wastedUsd !== undefined)
        expect(f.sources.reduce((a, s) => a + (s.usd ?? 0), 0)).toBeCloseTo(f.wastedUsd, 12);
    }
  });

  it('overlap fixture: sources stay consistent when claims compete', () => {
    const messages = syntheticSession();
    // add a failing call whose result also triggers oversized_output — both
    // claim result:cX, the priority order serves failed_call first
    messages.splice(
      10,
      0,
      assistant('2026-10-05T10:01:06Z', 90000, 200, [
        call('cX', 'Bash', { command: 'dump-config' }),
      ]),
      carrier('2026-10-05T10:01:07Z', result('cX', 'E'.repeat(40000)))
    );
    // carrier() builds isError: false — flip cX's result to an error in place
    const errCarrier = messages.find(
      (m) => m.type === 'user' && m.isMeta && m.toolResults.some((r) => r.toolUseId === 'cX')
    );
    expect(errCarrier).toBeDefined();
    if (errCarrier) errCarrier.toolResults[0].isError = true;
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger, undefined, undefined, true);
    const types = findings.map((f) => f.type);
    expect(types).toContain('failed_call');
    expect(types).toContain('oversized_output');
    for (const f of findings) {
      if (!f.sources) continue;
      expect(f.sources.reduce((a, s) => a + s.tokens, 0)).toBe(f.tokensWasted);
    }
  });
});

describe('baselineSession (known answer)', () => {
  const run = () => {
    const messages = syntheticSession();
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger, undefined, undefined, true);
    return baselineSession(ledger, findings, messages);
  };

  it('rules$ vs baseline$: rules explain 39.5% of cost, baseline 12.5%', () => {
    const row = run();
    expect(row.status).toBe('ok');
    expect(row.rounds).toBe(10);
    expect(row.topCount).toBe(1);
    expect(row.costUsd).toBeCloseTo(SYNTH_COST, 12);
    expect(row.rulesUsd).toBeCloseTo(SYNTH_RULES_USD, 12);
    expect(row.baselineUsd).toBeCloseTo(SYNTH_BASELINE_USD, 12);
    expect(row.rulesShare).toBeCloseTo(SYNTH_RULES_USD / SYNTH_COST, 9);
    expect(row.baselineShare).toBeCloseTo(SYNTH_BASELINE_USD / SYNTH_COST, 9);
    // rules win on this session
    expect(row.rulesUsd! > row.baselineUsd!).toBe(true);
  });

  it('attribution: wait_loop sits outside the top round → unexplained top = 100%', () => {
    const row = run();
    expect(row.rulesUsdInTop).toBe(0);
    expect(row.lossOutsideTopShare).toBe(1);
    expect(row.topUnexplainedShare).toBe(1);
    expect(row.topWithoutFindingsShare).toBe(1); // R7 has no finding at all
  });

  it('baseline2 (largest results, same volume): 104 tok, residency-priced', () => {
    const row = run();
    expect(row.baseline2Volume).toBe(SYNTH_B2_VOLUME);
    expect(row.baseline2Usd).toBeCloseTo(SYNTH_B2_USD, 15);
  });

  it('a session where the waste IS the top round: unexplained top drops to 0', () => {
    // make the wait-loop ticks the biggest rounds: cr 90k ticks in turn 2,
    // turn-1 rounds small → top = first 90k tick, wait_loop books it
    const messages = [
      makeMsg({ type: 'user', content: 't1', timestamp: new Date('2026-10-05T10:00:00Z') }),
      assistant('2026-10-05T10:00:05Z', 1000, 100, [call('c1', 'Bash', { command: 'ls' })]),
      carrier('2026-10-05T10:00:07Z', result('c1', 'ok')),
      makeMsg({ type: 'user', content: 't2', timestamp: new Date('2026-10-05T10:01:00Z') }),
      assistant('2026-10-05T10:01:05Z', 90000, 100),
      assistant('2026-10-05T10:01:10Z', 90000, 100),
      assistant('2026-10-05T10:01:15Z', 90000, 100),
      assistant('2026-10-05T10:01:20Z', 90000, 100),
      assistant('2026-10-05T10:01:25Z', 90000, 100),
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger, undefined, undefined, true);
    expect(findings.map((f) => f.type)).toContain('wait_loop');
    const row = baselineSession(ledger, findings, messages);
    expect(row.status).toBe('ok');
    expect(row.topCount).toBe(1);
    // top round = #4 (first 90k tick); wait_loop books all five ticks
    expect(row.rulesUsdInTop).toBeCloseTo(90000 * 0.2e-6, 12);
    // rules$ 0.09 >> baseline$ 0.019 — but only 1/5 of rules$ is inside top
    expect(row.lossOutsideTopShare).toBeCloseTo(4 / 5, 9);
    // the tick's OUTPUT $ (100 tok × $10/MTok = 0.001 of its 0.019 cost) is
    // not booked by wait_loop (input-side only) → 1/19 of top $ unexplained
    expect(row.topUnexplainedShare).toBeCloseTo(1 / 19, 9);
    expect(row.topWithoutFindingsShare).toBe(0);
  });

  it('unpriced sessions are excluded with a reason, not forced into the table', () => {
    const messages = [
      makeMsg({ type: 'user', content: 't1', timestamp: new Date('2026-10-05T10:00:00Z') }),
      assistant('2026-10-05T10:00:05Z', 1000, 100),
    ].map((m) => ({ ...m, model: m.type === 'assistant' ? 'unknown-model-x' : m.model }));
    const ledger = buildLedger(messages as ParsedMessage[]);
    const findings = computeFindings(messages as ParsedMessage[], ledger);
    const row = baselineSession(ledger, findings, messages as ParsedMessage[]);
    expect(row.status).toBe('no-cost');
    expect(row.rulesShare).toBeUndefined();
  });
});

describe('aggregateBaseline (paired stats, verdicts, honesty)', () => {
  const okRow = (
    rulesUsd: number,
    baselineUsd: number,
    typeUsd: { type: string; count: number; usd: number }[] = []
  ) => ({
    status: 'ok' as const,
    rounds: 10,
    topCount: 1,
    costUsd: 1,
    rulesUsd,
    baselineUsd,
    rulesUsdInTop: 0,
    rulesShare: rulesUsd / 1,
    baselineShare: baselineUsd / 1,
    lossOutsideTopShare: 0,
    topUnexplainedShare: 0,
    topWithoutFindingsShare: 0,
    typeUsd,
  });

  it('counts exclusions by reason', () => {
    const agg = aggregateBaseline([
      okRow(0.5, 0.3),
      { status: 'no-cost', rounds: 3, topCount: 0 },
      { status: 'partial-cost', rounds: 3, topCount: 0 },
      { status: 'unpriced-waste', rounds: 3, topCount: 0 },
    ]);
    expect(agg.sessions).toBe(4);
    expect(agg.headline).toBe(1);
    expect(agg.excluded).toEqual({ noCost: 1, partialCost: 1, unpricedWaste: 1 });
    expect(agg.cannotAnswer).toMatch(/need ≥ 10/);
    expect(agg.rulesBaseline.verdict).toBe('inconclusive');
  });

  it('straddling CI → inconclusive; per-type $ aggregated over headline rows', () => {
    // 7 wins / 2 ties / 3 losses → Wilson(7,10) ≈ [39.7%, 89.2%] straddles 50%
    const rows = [
      ...Array.from({ length: 7 }, (_, i) =>
        okRow(0.5, 0.3, [{ type: 'wait_loop' as const, count: 1, usd: 0.5 }])
      ),
      ...Array.from({ length: 2 }, () => okRow(0.4, 0.4)),
      ...Array.from({ length: 3 }, () => okRow(0.1, 0.3)),
    ];
    const agg = aggregateBaseline(rows);
    expect(agg.headline).toBe(12);
    expect(agg.rulesBaseline.win).toBe(7);
    expect(agg.rulesBaseline.tie).toBe(2);
    expect(agg.rulesBaseline.loss).toBe(3);
    expect(agg.rulesBaseline.ci?.lower).toBeGreaterThan(0.39);
    expect(agg.rulesBaseline.ci?.upper).toBeLessThan(0.9);
    expect(agg.rulesBaseline.verdict).toBe('inconclusive');
    expect(agg.types).toEqual([{ type: 'wait_loop', count: 7, usd: 3.5 }]);
    expect(MIN_PRICED_SESSIONS).toBe(10);
  });

  it('unanimous wins on ≥ MIN sessions → rules verdict', () => {
    const rows = Array.from({ length: 20 }, () => okRow(0.5, 0.1));
    expect(aggregateBaseline(rows).rulesBaseline.verdict).toBe('rules');
  });

  it('baseline sweep → baseline verdict; share stats are per-session', () => {
    const rows = Array.from({ length: 20 }, (_, i) => okRow(0.01, 0.3 + i * 0.001));
    const agg = aggregateBaseline(rows);
    expect(agg.rulesBaseline.verdict).toBe('baseline');
    expect(agg.rules?.median).toBeCloseTo(0.01, 12);
    expect(agg.baseline?.median).toBeCloseTo(0.3 + 9.5 * 0.001, 12);
  });
});

describe('report honesty on real fixture data', () => {
  it('basic-cache fixture: no findings → rules 0, baseline still positive', () => {
    const messages = syntheticSession().slice(0, 4); // no wait-loop possible
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger, undefined, undefined, true);
    expect(findings.filter((f) => f.kind === 'waste')).toHaveLength(0);
    const row = baselineSession(ledger, findings, messages);
    expect(row.rulesUsd).toBe(0);
    expect(row.baselineUsd).toBeGreaterThan(0);
    expect(row.topWithoutFindingsShare).toBe(1);
  });
});

describe('finding shape guards (#85 invariants)', () => {
  it('waste finding totals stay consistent with sources after allocation', () => {
    const messages = syntheticSession();
    const ledger = buildLedger(messages);
    const findings: Finding[] = computeFindings(messages, ledger, undefined, undefined, true);
    const waste = findings.filter((f) => f.kind === 'waste');
    expect(waste.length).toBeGreaterThan(0);
    for (const f of waste) {
      if (f.sources) {
        expect(
          approx(
            f.sources.reduce((a, s) => a + s.tokens, 0),
            f.tokensWasted
          )
        ).toBe(true);
      }
    }
  });
});
