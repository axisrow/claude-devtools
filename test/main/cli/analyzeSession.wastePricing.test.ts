/**
 * Waste pricing tests (#82, #83):
 *  - #82: findings carry wastedUsd (shared price table) and
 *    tokensWastedInputEq with cache residency — a result first bills as a
 *    cache write on the next round's request, then as a cache read per
 *    further round until compaction cuts it; cache_dead books only the
 *    uncached-input premium; every finding is marked measured | estimated.
 *    tokensWasted keeps its raw once-per-result semantics (PR #124 allocation
 *    + #131 harness contract).
 *  - #83: thinking is the BILLED estimate (output_tokens − visible output),
 *    not chars/4 of the returned (often empty) thinking text.
 */
import { describe, expect, it } from 'vitest';

import { buildLedger, computeFindings, sessionWasteTotals } from '../../../src/cli/analyzeSession';
import type { Finding, FindingType } from '../../../src/cli/analyzeSession';
import { estimateTokens } from '../../../src/shared/utils/tokenFormatting';
import type { ParsedMessage } from '../../../src/main/types';

let seq = 0;
function makeMsg(
  overrides: Partial<ParsedMessage> & { type: ParsedMessage['type'] }
): ParsedMessage {
  return {
    uuid: `u${++seq}`,
    parentUuid: null,
    timestamp: new Date(2026, 9, 20, 10, seq),
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

// claude-sonnet-5 $/MTok: input 2, output 10, cacheRead 0.2, cacheWrite5m 2.5
const SONNET = 'claude-sonnet-5';

describe('billed thinking (#83)', () => {
  it('a round with empty thinking text and large output_tokens has non-zero thinking', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        content: [{ type: 'thinking', thinking: '' } as never], // summary never returned
        usage: usage(10, 0, 0, 9000), // the paid thinking sits in output_tokens
      }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.rounds[0].thinkingTokens).toBe(9000);
    // thinking_heavy can now fire on such rounds at all
    const f = computeFindings(messages, ledger).find((x) => x.type === 'thinking_heavy');
    expect(f?.tokensWasted).toBe(9000);
    expect(f?.basis).toBe('estimated'); // #83: the estimate is marked as such
  });

  it('a round without thinking whose output equals its visible text estimates ~0', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        content: [{ type: 'text', text: 'x'.repeat(400) } as never], // 400 chars ≈ 100 tok
        usage: usage(10, 0, 0, 100),
      }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.rounds[0].thinkingTokens).toBe(0);
  });
});

// dup session: 5 rounds; round 2 Reads the same file twice (200-tok results)
const dupSession = (lastCtxRead: number) => [
  makeMsg({ type: 'user', content: 'go' }),
  makeMsg({ type: 'assistant', model: SONNET, usage: usage(100, 0, 0, 10) }),
  makeMsg({
    type: 'assistant',
    model: SONNET,
    usage: usage(100, 100, 0, 20),
    toolCalls: [
      { id: 't1', name: 'Read', input: { file_path: '/w82.ts' }, isTask: false },
      { id: 't2', name: 'Read', input: { file_path: '/w82.ts' }, isTask: false },
    ],
  }),
  makeMsg({
    type: 'user',
    isMeta: true,
    toolResults: [
      { toolUseId: 't1', content: 'a'.repeat(800), isError: false },
      { toolUseId: 't2', content: 'b'.repeat(800), isError: false },
    ],
  }),
  makeMsg({ type: 'assistant', model: SONNET, usage: usage(100, 500, 0, 20) }),
  makeMsg({ type: 'assistant', model: SONNET, usage: usage(100, 500, 0, 21) }),
  makeMsg({ type: 'assistant', model: SONNET, usage: usage(100, lastCtxRead, 0, 22) }),
];

describe('waste in dollars with cache residency (#82)', () => {
  const dupOf = (findings: Finding[]): Finding =>
    findings.find((f) => f.type === 'duplicate_call')!;

  it('a repeat in round k of M rounds costs its cache write + the re-reads after it', () => {
    const messages = dupSession(500); // no compaction — write at round 3, re-reads at 4–5
    const ledger = buildLedger(messages);
    const dup = dupOf(computeFindings(messages, ledger));
    // raw booking unchanged (PR #124 / #131 contract): the repeat result once
    expect(dup.tokensWasted).toBe(200);
    // the result first bills as a cache WRITE on the next round's request (it
    // cannot be read there — not cached yet), then as reads: rounds 4–5
    // $ = S×(cacheWrite5m + 2×cacheRead) = 200×(2.5 + 2×0.2)/1e6
    expect(dup.wastedUsd).toBeCloseTo(0.00058, 12);
    // input-token equivalent at the input rate ($2/MTok)
    expect(dup.tokensWastedInputEq).toBeCloseTo(290, 6);
    expect(dup.basis).toBe('estimated'); // result size is chars/4
  });

  it('compaction cuts the re-reads', () => {
    // last round re-reads 300 instead of 500 → contextDelta < 0 → residency ends
    const messages = dupSession(300);
    const ledger = buildLedger(messages);
    const dup = dupOf(computeFindings(messages, ledger));
    expect(dup.tokensWasted).toBe(200); // raw booking unchanged
    // write at round 3 + a single re-read at round 4; round 5's compaction cut
    expect(dup.wastedUsd).toBeCloseTo(0.00054, 12); // 200×(2.5 + 1×0.2)/1e6
    expect(dup.tokensWastedInputEq).toBeCloseTo(270, 6);
  });

  it('cache_dead books only the uncached-input premium in $, raw tokens stay compat', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: SONNET, usage: usage(30_000, 0, 0, 100) }),
    ];
    const ledger = buildLedger(messages);
    const f = computeFindings(messages, ledger).find((x) => x.type === 'cache_dead');
    expect(f?.tokensWasted).toBe(30_000); // legacy field keeps its semantics
    // premium: 30000×(input 2 − cacheRead 0.2)/1e6 — not the whole context
    expect(f?.wastedUsd).toBeCloseTo(0.054, 12);
    expect(f?.tokensWastedInputEq).toBeCloseTo(27_000, 6);
    expect(f?.basis).toBe('measured'); // contextSize is an API number
  });

  it('overlapped findings book no dollars twice (cache_dead vs wait_loop)', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'watch the job' }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeMsg({
          type: 'assistant',
          model: SONNET,
          usage: usage(60_000, 0, 0, 100 + i), // quiet tick AND cache_dead
        })
      ),
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const cacheDead = findings.filter((f) => f.type === 'cache_dead');
    const wait = findings.find((f) => f.type === 'wait_loop');
    // cache_dead books each round's premium: 5 × 60000×1.8/1e6
    expect(cacheDead.reduce((s, f) => s + (f.wastedUsd ?? 0), 0)).toBeCloseTo(0.54, 10);
    // wait_loop lost the token claim → books no dollars either
    expect(wait?.tokensWasted).toBe(0);
    expect(wait?.wastedUsd).toBeUndefined();
  });

  it('unpriced models carry basis but no dollar fields', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(30_000, 0, 0, 100) }),
    ];
    const ledger = buildLedger(messages);
    const f = computeFindings(messages, ledger).find((x) => x.type === 'cache_dead');
    expect(f?.wastedUsd).toBeUndefined();
    expect(f?.tokensWastedInputEq).toBeUndefined();
    expect(f?.basis).toBe('measured');
  });

  it('a failed call keeps its raw claim even when unpriced (allocation unchanged)', () => {
    const result = 'x'.repeat(40_000); // ~10k tok — also oversized
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1', // unpriced — no rates, but the claim must survive
        usage: usage(100, 0, 0, 50),
        toolCalls: [{ id: 't9', name: 'Bash', input: { command: 'dump stuff' }, isTask: false }],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        toolResults: [{ toolUseId: 't9', content: result, isError: true }],
      }),
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const failed = findings.find((f) => f.type === 'failed_call');
    const oversized = findings.find((f) => f.type === 'oversized_output');
    // failed_call's raw claim (args + result > oversized's) is served first on
    // the same toolUseId → oversized books 0 — exactly main's allocation
    expect(failed?.tokensWasted).toBe(
      estimateTokens(JSON.stringify({ command: 'dump stuff' })) + estimateTokens(result)
    );
    expect(oversized?.tokensWasted).toBe(0);
    expect(failed?.wastedUsd).toBeUndefined();
  });

  it('every finding is marked measured or estimated', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      // thinking_heavy (estimated) + cache_dead + context_spike on round 2
      makeMsg({
        type: 'assistant',
        model: SONNET,
        content: [{ type: 'thinking', thinking: '' } as never],
        usage: usage(1000, 0, 0, 9000),
      }),
      makeMsg({ type: 'assistant', model: SONNET, usage: usage(45_000, 0, 0, 10) }),
      // duplicate + failed on round 3
      makeMsg({
        type: 'assistant',
        model: SONNET,
        usage: usage(1000, 44_000, 0, 10),
        toolCalls: [
          { id: 'b1', name: 'Bash', input: { command: 'boom' }, isTask: false },
          { id: 'b2', name: 'Bash', input: { command: 'boom' }, isTask: false },
        ],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        toolResults: [
          { toolUseId: 'b1', content: 'Error: kaput', isError: true },
          { toolUseId: 'b2', content: 'Error: kaput', isError: true },
        ],
      }),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    const types = new Set(findings.map((f) => f.type));
    expect(types).toContain('thinking_heavy');
    expect(types).toContain('cache_dead');
    expect(types).toContain('context_spike');
    expect(types).toContain('failed_call');
    expect(types).toContain('duplicate_call');
    for (const f of findings) {
      expect(['measured', 'estimated']).toContain(f.basis);
    }
    const byType = (t: FindingType): Finding | undefined => findings.find((f) => f.type === t);
    expect(byType('duplicate_call')?.basis).toBe('estimated');
    expect(byType('failed_call')?.basis).toBe('estimated');
    expect(byType('thinking_heavy')?.basis).toBe('estimated');
    expect(byType('cache_dead')?.basis).toBe('measured');
    expect(byType('context_spike')?.basis).toBe('measured');
    expect(byType('context_spike')?.kind).toBe('observation'); // #84
  });
});

describe('waste vs observation split and session totals (#84)', () => {
  it('observations carry no dollar fields even on priced models', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: SONNET, usage: usage(1000, 0, 0, 1) }),
      makeMsg({ type: 'assistant', model: SONNET, usage: usage(45_000, 0, 0, 1) }), // +44k spike
    ];
    const f = computeFindings(messages, buildLedger(messages)).find(
      (x) => x.type === 'context_spike'
    );
    expect(f?.kind).toBe('observation');
    expect(f?.tokensWasted).toBe(0);
    expect(f?.wastedUsd).toBeUndefined();
    expect(f?.tokensWastedInputEq).toBeUndefined();
  });

  it('sessionWasteTotals: waste findings only, wasteShare = wastedUsd / costUsd', () => {
    const messages = dupSession(500); // known from above: dup books the only waste
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const dup = findings.find((f) => f.type === 'duplicate_call')!;
    const wt = sessionWasteTotals(findings, ledger);
    expect(wt.tokensWasted).toBe(dup.tokensWasted);
    expect(wt.wastedUsd).toBeCloseTo(dup.wastedUsd!, 12);
    expect(wt.wasteUsdPartial).toBe(false);
    expect(wt.wasteShare).toBeCloseTo(dup.wastedUsd! / ledger.totals.costUsd!, 12);
  });

  it('observations do not enter the session waste totals', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: SONNET, usage: usage(1000, 0, 0, 1) }),
      makeMsg({ type: 'assistant', model: SONNET, usage: usage(45_000, 0, 0, 1) }), // spike + cache_dead
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const dead = findings.find((f) => f.type === 'cache_dead')!;
    const wt = sessionWasteTotals(findings, ledger);
    expect(wt.tokensWasted).toBe(dead.tokensWasted); // the spike (0) is excluded
    expect(wt.wastedUsd).toBeCloseTo(dead.wastedUsd!, 12);
  });

  it('unpriced waste marks the totals partial, no share without $', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(30_000, 0, 0, 100) }), // cache_dead
    ];
    const ledger = buildLedger(messages);
    const wt = sessionWasteTotals(computeFindings(messages, ledger), ledger);
    expect(wt.tokensWasted).toBe(30_000);
    expect(wt.wastedUsd).toBeUndefined();
    expect(wt.wasteUsdPartial).toBe(true);
    expect(wt.wasteShare).toBeUndefined();
  });
});
