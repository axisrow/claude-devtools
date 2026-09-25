import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs hook script has no type declarations
import { analyzeTurn } from '../../scripts/turn-budget-hook.mjs';

/**
 * Turn input-budget hook: analyzeTurn() scans lines NEWEST-FIRST and sums
 * input-side usage until the turn boundary (real user message / compaction).
 *
 * Regression: streaming writes several JSONL lines per API request, each
 * carrying the FULL usage — naive summing triple-counts and fires the 15M
 * budget at ~7.5M real spend (session 804dea9a fired 8 denies at ~8M real).
 */

const USER_LINE = JSON.stringify({
  type: 'user',
  isMeta: false,
  message: { role: 'user', content: 'run the tests' },
});

/** Assistant usage line: full per-request usage. */
function usageLine(opts: {
  id: string;
  requestId?: string;
  input?: number;
  cacheRead?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      id: opts.id,
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
      usage: {
        input_tokens: opts.input ?? 1000,
        cache_read_input_tokens: opts.cacheRead ?? 340000,
        cache_creation_input_tokens: 0,
        output_tokens: 500,
      },
    },
  });
}

describe('turn-budget-hook analyzeTurn', () => {
  it('bills a fragmented request once: N streamed lines with full usage == one request', () => {
    // newest-first: three duplicate lines of request m2, then request m1, then boundary
    const lines = [
      usageLine({ id: 'm2', requestId: 'req-2' }),
      usageLine({ id: 'm2', requestId: 'req-2' }),
      usageLine({ id: 'm2', requestId: 'req-2' }),
      usageLine({ id: 'm1', requestId: 'req-1', cacheRead: 200000 }),
      usageLine({ id: 'm1', requestId: 'req-1', cacheRead: 200000 }),
      USER_LINE,
    ];
    const { spent, boundaryFound } = analyzeTurn(lines);
    // 2 requests: (1000+340000) + (1000+200000) = 542000 — NOT 3x and 2x that
    expect(spent).toBe(542000);
    expect(boundaryFound).toBe(true);
  });

  it('keys on requestId first: snapshot lines sharing requestId but not message.id bill once', () => {
    const lines = [
      usageLine({ id: 'mB', requestId: 'req-1' }),
      usageLine({ id: 'mA', requestId: 'req-1' }),
      USER_LINE,
    ];
    const { spent } = analyzeTurn(lines);
    expect(spent).toBe(341000);
  });

  it('keeps the newest line per request (backward scan, first seen wins)', () => {
    const lines = [
      // newest fragment carries the final counts
      usageLine({ id: 'm1', requestId: 'req-1', cacheRead: 500000 }),
      usageLine({ id: 'm1', requestId: 'req-1', cacheRead: 400000 }),
      USER_LINE,
    ];
    const { spent } = analyzeTurn(lines);
    expect(spent).toBe(501000);
  });

  it('stops at the turn boundary: pre-turn usage does not count', () => {
    const lines = [
      usageLine({ id: 'm2', requestId: 'req-2' }),
      USER_LINE,
      usageLine({ id: 'm1', requestId: 'req-1', cacheRead: 999999 }),
    ];
    const { spent, boundaryFound } = analyzeTurn(lines);
    expect(spent).toBe(341000);
    expect(boundaryFound).toBe(true);
  });

  it('stops at a compaction marker: post-compact turn starts fresh', () => {
    const lines = [
      usageLine({ id: 'm2', requestId: 'req-2' }),
      JSON.stringify({
        type: 'user',
        isMeta: true,
        isCompactSummary: true,
        message: { content: [] },
      }),
      usageLine({ id: 'm1', requestId: 'req-1', cacheRead: 999999 }),
    ];
    const { spent } = analyzeTurn(lines);
    expect(spent).toBe(341000);
  });
});
