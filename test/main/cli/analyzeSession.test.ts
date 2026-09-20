/**
 * Tests for the token-analytics CLI (src/cli/*).
 * Covers the ported prototype logic: turn boundaries, requestId dedup,
 * duplicate-call keys, waste findings, slow-subagent math, inventory scan.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  breakdownFromRounds,
  buildLedger,
  computeFindings,
  detectBillingScheme,
  filterLedgerByDate,
  normalizeCallKey,
  parseArgs,
  priceFamily,
} from '../../../src/cli/analyzeSession';
import { mapWithConcurrency, scanSessionFile } from '../../../src/cli/sessionInventory';
import { estimateTokens } from '../../../src/shared/utils/tokenFormatting';
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

describe('buildLedger', () => {
  it('starts turns only on real user messages, not isMeta tool-result carriers', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'hello' }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(100, 1000, 50, 10) }),
      makeMsg({
        type: 'user',
        isMeta: true,
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' } as never],
        toolResults: [{ toolUseId: 't1', content: 'ok', isError: false }],
      }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        usage: usage(120, 1100, 0, 20),
        toolCalls: [{ id: 't2', name: 'Bash', input: { command: 'ls' }, isTask: false }],
      }),
    ];

    const ledger = buildLedger(messages);
    expect(ledger.turns).toHaveLength(1);
    expect(ledger.rounds).toHaveLength(2);
    expect(ledger.rounds[1].contextDelta).toBe(120 + 1100 - (100 + 1000 + 50));
    expect(ledger.rounds[1].tools).toEqual(['Bash']);
    expect(ledger.totals.outputTokens).toBe(30);
  });

  it('deduplicates streaming entries by requestId keeping the last usage', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        requestId: 'r1',
        usage: usage(100, 0, 0, 5),
      }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        requestId: 'r1',
        usage: usage(100, 0, 0, 25),
      }),
    ];

    const ledger = buildLedger(messages);
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.totals.outputTokens).toBe(25);
  });

  it('excludes sidechain and <synthetic> assistant messages', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: '<synthetic>', usage: usage(9, 0, 0, 1) }),
      makeMsg({ type: 'assistant', isSidechain: true, model: 'm1', usage: usage(50, 0, 0, 5) }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(10, 0, 0, 2) }),
    ];

    const ledger = buildLedger(messages);
    expect(ledger.rounds).toHaveLength(1);
    expect(ledger.totals.inputTokens).toBe(10);
  });
});

describe('normalizeCallKey', () => {
  it('collapses whitespace in Bash commands', () => {
    expect(normalizeCallKey('Bash', { command: 'pnpm   test' })).toBe(
      normalizeCallKey('Bash', { command: 'pnpm test' })
    );
  });

  it('distinguishes different files for Read', () => {
    expect(normalizeCallKey('Read', { file_path: '/a' })).not.toBe(
      normalizeCallKey('Read', { file_path: '/b' })
    );
  });

  it('keeps nested object inputs distinct in the default branch', () => {
    expect(normalizeCallKey('TodoWrite', { todos: [{ content: 'a' }] })).not.toBe(
      normalizeCallKey('TodoWrite', { todos: [{ content: 'b' }] })
    );
  });

  it('does not swallow a following flag as a value', () => {
    const opts = parseArgs(['--rounds', '--json', 'x.jsonl']);
    expect(opts.rounds).toBe(20);
    expect(opts.json).toBe(true);
    expect(opts.sessionPath).toBe('x.jsonl');
  });
});

describe('computeFindings', () => {
  it('flags duplicate calls, real failures, and skips user rejections', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        usage: usage(10, 0, 0, 1),
        toolCalls: [
          { id: 't1', name: 'Bash', input: { command: 'pytest -q' }, isTask: false },
          { id: 't2', name: 'Bash', input: { command: 'pytest -q' }, isTask: false },
          { id: 't3', name: 'Bash', input: { command: 'boom' }, isTask: false },
          { id: 't4', name: 'Bash', input: { command: 'declined' }, isTask: false },
        ],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        toolResults: [
          { toolUseId: 't1', content: 'all passed', isError: false },
          { toolUseId: 't2', content: 'all passed', isError: false },
          { toolUseId: 't3', content: 'Traceback: boom', isError: true },
          {
            toolUseId: 't4',
            content: "The user doesn't want to proceed with this tool use.",
            isError: true,
          },
        ],
      }),
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    const types = findings.map((f) => f.type);

    expect(types).toContain('duplicate_call');
    expect(types).toContain('failed_call');
    const failed = findings.filter((f) => f.type === 'failed_call');
    expect(failed).toHaveLength(1); // only the real failure, not the rejection
    const dup = findings.find((f) => f.type === 'duplicate_call');
    expect(dup?.tokensWasted).toBe(estimateTokens('all passed')); // one re-read, not both results
  });

  it('scopes tool-call findings to the window but resolves results from all messages', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go', timestamp: new Date('2026-09-01T10:00:00Z') }),
      makeMsg({
        type: 'assistant',
        timestamp: new Date('2026-09-01T10:01:00Z'),
        usage: usage(10, 0, 0, 1),
        toolCalls: [{ id: 'a', name: 'Bash', input: { command: 'pytest -q' }, isTask: false }],
      }),
      makeMsg({
        type: 'assistant',
        timestamp: new Date('2026-09-20T10:00:00Z'),
        usage: usage(10, 0, 0, 1),
        toolCalls: [
          { id: 'b1', name: 'Bash', input: { command: 'pytest -q' }, isTask: false },
          { id: 'b2', name: 'Bash', input: { command: 'pytest -q' }, isTask: false },
          { id: 'c', name: 'Bash', input: { command: 'boom' }, isTask: false },
        ],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        timestamp: new Date('2026-09-25T10:00:00Z'),
        toolResults: [
          { toolUseId: 'a', content: 'all passed', isError: false },
          { toolUseId: 'b1', content: 'all passed', isError: false },
          { toolUseId: 'b2', content: 'all passed', isError: false },
          { toolUseId: 'c', content: 'Traceback: boom', isError: true },
        ],
      }),
    ];
    const ledger = buildLedger(messages);
    const findings = computeFindings(
      messages,
      ledger,
      new Date(2026, 8, 15),
      new Date(2026, 8, 20, 23, 59, 59, 999)
    );

    // only the two in-window 'pytest -q' calls count — the Sep 1 call is out of scope
    const dup = findings.find((f) => f.type === 'duplicate_call');
    expect(dup).toBeDefined();
    expect(dup?.tokensWasted).toBe(estimateTokens('all passed'));
    // 'boom' fails inside the window, its result lands after --until and still resolves
    expect(findings.filter((f) => f.type === 'failed_call')).toHaveLength(1);
  });

  it('flags context spikes and dead caching from ledger rounds', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(1000, 0, 0, 1) }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(45000, 0, 0, 1) }),
    ];

    const ledger = buildLedger(messages);
    const findings = computeFindings(messages, ledger);
    expect(findings.some((f) => f.type === 'context_spike')).toBe(true);
    expect(findings.some((f) => f.type === 'cache_dead')).toBe(true);
  });
});

describe('scanSessionFile', () => {
  it('computes duration, dedups usage per requestId, excludes synthetic and sidechain usage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-inv-'));
    try {
      const file = path.join(dir, 'session1.jsonl');
      await writeFile(
        file,
        [
          JSON.stringify({ type: 'user', uuid: '1', timestamp: '2026-09-20T10:00:00Z' }),
          JSON.stringify({
            type: 'assistant',
            uuid: '2',
            timestamp: '2026-09-20T10:05:00Z',
            requestId: 'r1',
            message: {
              model: 'claude-sonnet-5',
              usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 },
            },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: '3',
            timestamp: '2026-09-20T10:06:00Z',
            requestId: 'r1',
            message: {
              model: 'claude-sonnet-5',
              usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
            },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: '4',
            timestamp: '2026-09-20T10:07:00Z',
            message: { model: '<synthetic>', usage: { input_tokens: 9, output_tokens: 1 } },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: '5',
            timestamp: '2026-09-20T10:08:00Z',
            isSidechain: true,
            requestId: 'r2',
            message: {
              model: 'claude-haiku-4-5',
              usage: { input_tokens: 500, output_tokens: 50, cache_creation_input_tokens: 30 },
            },
          }),
        ].join('\n')
      );

      const entry = await scanSessionFile(file);
      expect(entry).not.toBeNull();
      // sidechain timestamps span the file, but its tokens/models/billing stay out
      expect(entry?.durationMs).toBe(8 * 60 * 1000);
      expect(entry?.models).toEqual(['claude-sonnet-5']);
      expect(entry?.inputTokens).toBe(10);
      expect(entry?.outputTokens).toBe(5);
      expect(entry?.cacheReadTokens).toBe(100);
      expect(entry?.cacheCreationTokens).toBe(0);
      expect(entry?.messageCount).toBe(5);
      expect(entry?.billing).toBe('router-style');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('mapWithConcurrency', () => {
  it('isolates per-item failures as null entries', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('EACCES: permission denied');
        return n * 10;
      });
      expect(results).toHaveLength(3);
      expect(results).toContain(10);
      expect(results).toContain(30);
      expect(results).toContain(null);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('priceFamily and billing scheme', () => {
  it('extracts claude family from short ids without date', () => {
    expect(priceFamily('claude-sonnet-5')).toBe('sonnet');
    expect(priceFamily('claude-sonnet-5-20250929')).toBe('sonnet');
    expect(priceFamily('glm-5.3-flash')).toBeNull();
  });

  it('detects billing scheme from round signatures', () => {
    const w = { cacheReadTokens: 0, cacheCreationTokens: 100 };
    const r = { cacheReadTokens: 500, cacheCreationTokens: 0 };
    const n = { cacheReadTokens: 0, cacheCreationTokens: 0 };
    expect(detectBillingScheme([w, r])).toBe('mixed');
    expect(detectBillingScheme([w])).toBe('anthropic-style');
    expect(detectBillingScheme([r, r])).toBe('router-style');
    expect(detectBillingScheme([n])).toBe('no-cache');
  });

  it('computes cost for anthropic-style sessions logged with short model ids', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'claude-sonnet-5',
        usage: usage(100, 1000, 200, 50),
      }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.billing).toBe('anthropic-style');
    expect(ledger.totals.costUsd).toBeDefined();
    expect(ledger.totals.costUsd).toBeGreaterThan(0);
    expect(ledger.totals.costPartial).toBe(false);
  });

  it('labels router-style sessions without cost', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(100, 4000, 0, 10) }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.billing).toBe('router-style');
    expect(ledger.totals.costUsd).toBeUndefined();
  });

  it('marks cost partial when the session mixes priced and unpriced models', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'claude-sonnet-5', usage: usage(100, 0, 0, 10) }),
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(100, 0, 0, 10) }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.totals.costUsd).toBeDefined();
    expect(ledger.totals.costPartial).toBe(true);
  });
});

describe('unified flag grammar', () => {
  it('parses --since/--until as local day bounds (dash and compact forms)', () => {
    const opts = parseArgs(['--since', '2026-09-01', '--until', '20260920', 'x.jsonl']);
    expect(opts.since).toEqual(new Date(2026, 8, 1));
    expect(opts.until).toEqual(new Date(2026, 8, 20, 23, 59, 59, 999));
    expect(opts.sessionPath).toBe('x.jsonl');
  });

  it('reports an error for malformed date bounds', () => {
    expect(parseArgs(['--since', 'nah']).error).toContain('--since');
    expect(parseArgs(['--until', '2026-13-01']).error).toContain('--until');
  });

  it('keeps bare --last as pick-newest and numeric --last N as a calendar window', () => {
    expect(parseArgs(['--project', 'p', '--last']).useLast).toBe(true);
    const midnight = (back: number): Date => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - back);
      return d;
    };
    const w = parseArgs(['--last', '7']);
    expect(w.useLast).toBe(false);
    expect(w.lastDays).toBe(7);
    expect(w.since).toEqual(midnight(6)); // ccusage-style: local midnight, N=1 → today
  });

  it('does not swallow a non-numeric --last value or a following flag', () => {
    const a = parseArgs(['--last', 'x.jsonl']);
    expect(a.useLast).toBe(true);
    expect(a.sessionPath).toBe('x.jsonl');
    const b = parseArgs(['--last', '--json']);
    expect(b.useLast).toBe(true);
    expect(b.json).toBe(true);
  });

  it('parses --breakdown and --no-cost', () => {
    const opts = parseArgs(['--breakdown', '--no-cost', '--json']);
    expect(opts.breakdown).toBe(true);
    expect(opts.noCost).toBe(true);
    expect(opts.json).toBe(true);
  });
});

describe('filterLedgerByDate and breakdownFromRounds', () => {
  const twoModelSession = () => [
    makeMsg({ type: 'user', content: 'go' }),
    makeMsg({
      type: 'assistant',
      model: 'claude-sonnet-5',
      timestamp: new Date('2026-09-01T10:00:00Z'),
      usage: usage(100, 1000, 0, 10),
    }),
    makeMsg({
      type: 'assistant',
      model: 'glm-5.3-flash',
      timestamp: new Date('2026-09-15T10:00:00Z'),
      usage: usage(50, 0, 0, 5),
    }),
    makeMsg({
      type: 'assistant',
      model: 'claude-sonnet-5',
      timestamp: new Date('2026-09-20T10:00:00Z'),
      usage: usage(30, 0, 0, 2),
    }),
  ];

  it('keeps rounds inside the window and recomputes totals/models/duration', () => {
    const ledger = buildLedger(twoModelSession());
    const filtered = filterLedgerByDate(ledger, new Date(2026, 8, 15), undefined);
    expect(filtered.rounds).toHaveLength(2);
    expect(filtered.totals.inputTokens).toBe(80);
    expect(filtered.totals.outputTokens).toBe(7);
    expect(filtered.models).toEqual(['glm-5.3-flash', 'claude-sonnet-5']);
    expect(filtered.durationMs).toBe(
      new Date('2026-09-20T10:00:00Z').getTime() - new Date('2026-09-15T10:00:00Z').getTime()
    );
  });

  it('recomputes cost from kept rounds only and flags partial when unpriced', () => {
    const ledger = buildLedger(twoModelSession());
    const filtered = filterLedgerByDate(
      ledger,
      new Date(2026, 8, 15),
      new Date(2026, 8, 30, 23, 59, 59, 999)
    );
    // kept: glm (unpriced) + sonnet 30/0/0/2 → (30*3 + 2*15) / 1e6
    expect(filtered.totals.costUsd).toBeCloseTo(0.00012, 10);
    expect(filtered.totals.costPartial).toBe(true);
  });

  it('returns the ledger untouched without bounds', () => {
    const ledger = buildLedger(twoModelSession());
    expect(filterLedgerByDate(ledger)).toBe(ledger);
  });

  it('breakdown groups tokens per model and drops cost for unpriced ones', () => {
    const rows = breakdownFromRounds(buildLedger(twoModelSession()).rounds);
    expect(rows).toHaveLength(2);
    const sonnet = rows.find((r) => r.model === 'claude-sonnet-5');
    expect(sonnet?.billedTokens).toBe(100 + 1000 + 10 + 30 + 2);
    // (100*3 + 10*15 + 1000*0.3) + (30*3 + 2*15) = 750 + 120 per 1e6
    expect(sonnet?.costUsd).toBeCloseTo(0.00087, 10);
    expect(rows.find((r) => r.model === 'glm-5.3-flash')?.costUsd).toBeUndefined();
  });
});
