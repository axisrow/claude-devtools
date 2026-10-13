/**
 * Waste-allocation tests: a round / tool result may be counted at most once
 * across all findings' tokensWasted (the corpus invariant wasted-le-billed
 * tripped on 9/868 real sessions because overlapping findings each booked the
 * same round's contextSize — cache_dead + wait_loop on one quiet round, or one
 * failed Bash x3 feeding failed_call + loop_streak + duplicate_call + probe).
 * #84: claims are served in a documented TYPE priority (not severity+size),
 * and observations (context_spike, long_turn) book nothing at all.
 */
import { describe, expect, it } from 'vitest';

import { buildLedger, computeFindings } from '../../../src/cli/analyzeSession';
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

const sumWasted = (findings: ReturnType<typeof computeFindings>): number =>
  findings.reduce((s, f) => s + f.tokensWasted, 0);

describe('findings waste allocation (no double counting)', () => {
  it('a round claimed by cache_dead is not booked again by wait_loop', () => {
    const messages: ParsedMessage[] = [
      makeMsg({ type: 'user', content: 'watch the job' }),
      // every round is BOTH a quiet tick (no tools, 60k in, ~100 out) and a
      // cache_dead round (cr = cw = 0): two findings claim the same 60k
      ...Array.from({ length: 5 }, (_, i) =>
        makeMsg({
          type: 'assistant',
          model: 'm1',
          usage: usage(60_000, 0, 0, 100 + i),
        })
      ),
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    expect(findings.some((f) => f.type === 'cache_dead')).toBe(true);
    expect(findings.some((f) => f.type === 'wait_loop')).toBe(true);
    // the corpus invariant, locally: overlapping claims must not double-book
    expect(sumWasted(findings)).toBeLessThanOrEqual(ledger.totals.billedTokens);
    // agreed semantics: the higher-priority claim keeps the full round, the
    // overlapped one stays visible with 0
    const cacheDead = findings.filter((f) => f.type === 'cache_dead');
    expect(cacheDead).toHaveLength(5);
    for (const f of cacheDead) expect(f.tokensWasted).toBe(60_000);
    expect(findings.find((f) => f.type === 'wait_loop')?.tokensWasted).toBe(0);
  });

  it('one call fitting four types books once, in the top-priority category (#84)', () => {
    // 4 identical failing calls: failed_call + loop_streak + duplicate_call +
    // probe_no_progress all fire on the same result sources. The documented
    // type priority (#84) serves failed_call first — an error result is waste
    // with certainty — so each failed call books its own args + result, and
    // the pattern findings stay visible with 0. No token is counted twice.
    const result = 'x'.repeat(2000); // ~500 estimated tokens per result
    const bashCall = (n: number) => ({
      id: `t${n}`,
      name: 'Bash',
      input: { command: 'kubectl get pods' },
      isTask: false,
    });
    const messages: ParsedMessage[] = [
      makeMsg({ type: 'user', content: 'check deploys' }),
      // 4 identical failing calls: LOOP_MIN_STREAK on the merged tree is 4
      ...Array.from({ length: 4 }, (_, i) =>
        makeMsg({
          type: 'assistant',
          model: 'm1',
          // distinct outputs: identical counters would read as router-retry copies
          usage: usage(100, 0, 1000, 50 + i),
          toolCalls: [bashCall(i + 1)],
          toolResults: [{ toolUseId: `t${i + 1}`, content: result, isError: true }],
        })
      ),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        usage: usage(100, 0, 1000, 60),
        content: 'giving up',
      }),
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const types = new Set(findings.map((f) => f.type));
    // all four finding types still fire — only the booking is prioritized
    expect(types.has('failed_call')).toBe(true);
    expect(types.has('loop_streak')).toBe(true);
    expect(types.has('duplicate_call')).toBe(true);
    expect(types.has('probe_no_progress')).toBe(true);

    const perCall = estimateTokens(JSON.stringify({ command: 'kubectl get pods' })) + estimateTokens(result);
    const failed = findings.filter((f) => f.type === 'failed_call');
    expect(failed).toHaveLength(4);
    for (const f of failed) {
      expect(f.tokensWasted).toBe(perCall); // highest-priority category holds the booking
      expect(f.kind).toBe('waste');
    }
    for (const t of ['loop_streak', 'duplicate_call', 'probe_no_progress'] as const) {
      expect(findings.find((f) => f.type === t)?.tokensWasted).toBe(0);
    }
    // the sum counts each token exactly once
    expect(sumWasted(findings)).toBe(4 * perCall);
    expect(sumWasted(findings)).toBeLessThanOrEqual(ledger.totals.billedTokens);
  });

  it('context_spike is an observation: books nothing, no dollars, kind set (#84)', () => {
    const messages: ParsedMessage[] = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'claude-sonnet-5', usage: usage(1000, 0, 0, 1) }),
      // +44k in one round: context_spike AND cache_dead on the same round
      makeMsg({ type: 'assistant', model: 'claude-sonnet-5', usage: usage(45_000, 0, 0, 1) }),
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const spike = findings.find((f) => f.type === 'context_spike');
    expect(spike).toBeDefined();
    expect(spike?.kind).toBe('observation');
    expect(spike?.tokensWasted).toBe(0); // a big growth is not necessarily waste
    expect(spike?.wastedUsd).toBeUndefined();
    // the round stays bookable by waste categories — cache_dead keeps it
    const dead = findings.find((f) => f.type === 'cache_dead');
    expect(dead?.kind).toBe('waste');
    expect(dead?.tokensWasted).toBe(45_000);
    for (const f of findings) expect(['waste', 'observation']).toContain(f.kind);
  });

  it('long_turn stays an observation and carries kind (#84)', () => {
    const at = (min: number): Date => new Date(Date.UTC(2026, 8, 20, 10, min));
    const messages: ParsedMessage[] = [
      makeMsg({ type: 'user', content: 'go', timestamp: at(0) }),
      ...Array.from({ length: 14 }, (_, i) =>
        makeMsg({
          type: 'assistant',
          model: 'm1',
          timestamp: at(i * 5),
          usage: usage(10, 0, 0, 1),
        })
      ),
    ];
    const long = computeFindings(messages, buildLedger(messages)).find(
      (f) => f.type === 'long_turn'
    );
    expect(long).toBeDefined();
    expect(long?.kind).toBe('observation');
    expect(long?.tokensWasted).toBe(0);
  });
});
