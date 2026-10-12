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
  roundCostUsd,
  turnActiveMinutes,
} from '../../../src/cli/analyzeSession';
import type { RoundRow } from '../../../src/cli/analyzeSession';
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

  it('distinguishes different Read slices of one file (#90)', () => {
    const base = { file_path: '/a' };
    expect(normalizeCallKey('Read', base)).not.toBe(
      normalizeCallKey('Read', { ...base, offset: 100 })
    );
    expect(normalizeCallKey('Read', { ...base, offset: 100 })).not.toBe(
      normalizeCallKey('Read', { ...base, offset: 200 })
    );
    expect(normalizeCallKey('Read', { ...base, limit: 50 })).not.toBe(
      normalizeCallKey('Read', { ...base, limit: 100 })
    );
  });

  it('keys file mutations by their content: different edits are not duplicates (#90)', () => {
    expect(
      normalizeCallKey('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })
    ).not.toBe(normalizeCallKey('Edit', { file_path: '/a', old_string: 'x', new_string: 'z' }));
    expect(
      normalizeCallKey('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })
    ).not.toBe(normalizeCallKey('Edit', { file_path: '/a', old_string: 'w', new_string: 'y' }));
    expect(normalizeCallKey('Write', { file_path: '/a', content: 'one' })).not.toBe(
      normalizeCallKey('Write', { file_path: '/a', content: 'two' })
    );
    expect(normalizeCallKey('NotebookEdit', { notebook_path: '/a', new_source: 'a' })).not.toBe(
      normalizeCallKey('NotebookEdit', { notebook_path: '/a', new_source: 'b' })
    );
    expect(normalizeCallKey('NotebookEdit', { notebook_path: '/a', new_source: 'a' })).not.toBe(
      normalizeCallKey('NotebookEdit', { notebook_path: '/b', new_source: 'a' })
    );
  });

  it('still collapses an identical mutation to the same key (#90)', () => {
    const edit = { file_path: '/a', old_string: 'x', new_string: 'y' };
    expect(normalizeCallKey('Edit', edit)).toBe(normalizeCallKey('Edit', { ...edit }));
    expect(normalizeCallKey('Write', { file_path: '/a', content: 'same' })).toBe(
      normalizeCallKey('Write', { file_path: '/a', content: 'same' })
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

describe('billing scheme', () => {
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

  it('prices router-style glm rounds and leaves unpriced models without cost', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(100, 4000, 0, 10) }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.billing).toBe('router-style');
    // glm is priced now: (100*0.075 + 4000*0.015 + 10*0.25) / 1e6 = 70 / 1e6
    expect(ledger.totals.costUsd).toBeCloseTo(0.00007, 8);
  });

  it('marks cost partial when the session mixes priced and unpriced models', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'claude-sonnet-5', usage: usage(100, 0, 0, 10) }),
      makeMsg({ type: 'assistant', model: 'deepseek-v4-flash', usage: usage(100, 0, 0, 10) }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.totals.costUsd).toBeDefined();
    expect(ledger.totals.costPartial).toBe(true);
  });
});

describe('pricing (#72) — rates hand-written from Anthropic published prices 2026-10-12', () => {
  const round = (model: string, o: Partial<RoundRow> = {}): RoundRow => ({
    index: 1,
    timestamp: new Date('2026-10-12T10:00:00Z'),
    turnIndex: 1,
    model,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    contextSize: 0,
    contextDelta: 0,
    thinkingTokens: 0,
    tools: [],
    ...o,
  });

  // rows: model, input, output, cacheRead, cacheWrite5m, cacheWrite1h ($/MTok);
  // numbers from platform.claude.com/pricing, NOT derived from the app's table
  it.each([
    ['claude-opus-4-8', 5, 25, 0.5, 6.25, 10],
    ['claude-opus-5', 5, 25, 0.5, 6.25, 10],
    ['claude-opus-5-5', 4, 20, 0.2, 5, 8],
    ['claude-sonnet-4-5', 3, 15, 0.3, 3.75, 6],
    ['claude-sonnet-5', 2, 10, 0.2, 2.5, 4],
    ['claude-sonnet-5-5', 2, 10, 0.2, 2.5, 4],
    ['claude-haiku-4-5', 1, 5, 0.1, 1.25, 2],
    // haiku 5.5: 1M input is a >100K long prompt, so that cell bills at the
    // published 0.50 long-prompt rate; the base tier (0.10/0.50) is pinned
    // by the tier test below
    ['claude-haiku-5-5', 0.5, 0.5, 0.01, 0.125, 0.2],
    ['claude-fable-5', 10, 50, 0.25, 12.5, 20],
    ['claude-fable-5-1', 10, 50, 0.25, 12.5, 20],
    ['claude-opus-4-1', 15, 75, 1.5, 18.75, 30], // legacy opus ≤4.1
    // dated 4.0 id parses with minor=null — must stay legacy, not 4.5+ rates
    ['claude-opus-4-20250514', 15, 75, 1.5, 18.75, 30],
    ['glm-5.3-flash', 0.075, 0.25, 0.015, 0.075, 0.075], // router: write = input rate
  ])(
    '%s bills 1M tokens of each kind at the published rate',
    (model, input, output, cr, cw5m, cw1h) => {
      expect(roundCostUsd(round(model, { inputTokens: 1e6 }))).toBeCloseTo(input, 8);
      expect(roundCostUsd(round(model, { outputTokens: 1e6 }))).toBeCloseTo(output, 8);
      expect(roundCostUsd(round(model, { cacheReadTokens: 1e6 }))).toBeCloseTo(cr, 8);
      // no TTL breakdown → the whole write is billed at the 5m rate
      expect(roundCostUsd(round(model, { cacheCreationTokens: 1e6 }))).toBeCloseTo(cw5m, 8);
      expect(
        roundCostUsd(round(model, { cacheCreationTokens: 1e6, cacheWrite5mTokens: 1e6 }))
      ).toBeCloseTo(cw5m, 8);
      expect(
        roundCostUsd(
          round(model, { cacheCreationTokens: 1e6, cacheWrite5mTokens: 0, cacheWrite1hTokens: 1e6 })
        )
      ).toBeCloseTo(cw1h, 8);
    }
  );

  it('bills a mixed 5m/1h cache-write round at both rates (opus 5.5)', () => {
    // 1M in @4 + 600k write @5 (5m) + 400k write @8 (1h) + 50k out @20 = 11.2
    const cost = roundCostUsd(
      round('claude-opus-5-5', {
        inputTokens: 1e6,
        cacheCreationTokens: 1e6,
        cacheWrite5mTokens: 600_000,
        cacheWrite1hTokens: 400_000,
        outputTokens: 50_000,
      })
    );
    expect(cost).toBeCloseTo(11.2, 8);
  });

  it('haiku 5.5 switches to the published long-prompt tier above 100K prompt tokens', () => {
    // 150k in @0.50 + 10k out @2.50
    const long = roundCostUsd(
      round('claude-haiku-5-5', { inputTokens: 150_000, outputTokens: 10_000 })
    );
    expect(long).toBeCloseTo(0.075 + 0.025, 10);
    // 90k fresh + 20k cache-read = 110k prompt → long tier (cr @0.01)
    const viaCache = roundCostUsd(
      round('claude-haiku-5-5', {
        inputTokens: 90_000,
        cacheReadTokens: 20_000,
        outputTokens: 10_000,
      })
    );
    expect(viaCache).toBeCloseTo(0.045 + 0.025 + 0.0002, 10);
    // exactly 100K stays on the base tier
    const short = roundCostUsd(
      round('claude-haiku-5-5', { inputTokens: 100_000, outputTokens: 10_000 })
    );
    expect(short).toBeCloseTo(0.01 + 0.005, 10);
  });

  it('buildLedger carries the usage cache-write TTL split; without it the whole write is 5m', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          cache_creation_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
        },
      }),
      makeMsg({
        type: 'assistant',
        model: 'claude-opus-5-5',
        usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 1000 },
      }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.rounds[0].cacheWrite5mTokens).toBe(600);
    expect(ledger.rounds[0].cacheWrite1hTokens).toBe(400);
    // r0: 100*4 + 600*5 + 400*8 + 10*20 = 6800; r1 (no split, all 5m): 100*4 + 1000*5 + 10*20 = 5600
    expect(ledger.totals.costUsd).toBeCloseTo(0.0124, 10);
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

  it('recomputes cost from kept rounds only (glm now priced, no partial flag)', () => {
    const ledger = buildLedger(twoModelSession());
    const filtered = filterLedgerByDate(
      ledger,
      new Date(2026, 8, 15),
      new Date(2026, 8, 30, 23, 59, 59, 999)
    );
    // kept: glm (50*0.075 + 5*0.25) + sonnet-5 (30*2 + 2*10) → 85 / 1e6
    expect(filtered.totals.costUsd).toBeCloseTo(0.000085, 10);
    expect(filtered.totals.costPartial).toBe(false);
  });

  it('returns the ledger untouched without bounds', () => {
    const ledger = buildLedger(twoModelSession());
    expect(filterLedgerByDate(ledger)).toBe(ledger);
  });

  it('breakdown groups tokens per model with per-model cost', () => {
    const rows = breakdownFromRounds(buildLedger(twoModelSession()).rounds);
    expect(rows).toHaveLength(2);
    const sonnet = rows.find((r) => r.model === 'claude-sonnet-5');
    expect(sonnet?.billedTokens).toBe(100 + 1000 + 10 + 30 + 2);
    // (100*2 + 10*10 + 1000*0.2) + (30*2 + 2*10) = 500 + 80 per 1e6
    expect(sonnet?.costUsd).toBeCloseTo(0.00058, 10);
    // glm: (50*0.075 + 5*0.25) / 1e6
    expect(rows.find((r) => r.model === 'glm-5.3-flash')?.costUsd).toBeCloseTo(0.000005, 10);
  });
});

describe('data quality (issues #14/#15)', () => {
  it('zero-usage rounds: no false spike, baseline kept, counted as noUsageRounds', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(1000, 0, 0, 100) }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(0, 0, 0, 0) }), // ghost, #14
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(2000, 0, 0, 100) }),
    ];
    const ledger = buildLedger(messages);
    // round 3 measures against round 1, not against the ghost
    expect(ledger.rounds[2].contextDelta).toBe(1000);
    expect(ledger.totals.noUsageRounds).toBe(1);
    expect(ledger.totals.retryCopies).toBe(0);
    expect(computeFindings(messages, ledger).some((f) => f.type === 'context_spike')).toBe(false);
  });

  it('flags router-retry copies without touching sums or doubling findings', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(335200, 0, 0, 100) }),
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(335200, 0, 0, 100) }),
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(335200, 0, 0, 100) }),
    ];
    const ledger = buildLedger(messages);
    expect(ledger.totals.retryCopies).toBe(2);
    // variant A: sums stay untouched — gluing is postponed until billing is known
    expect(ledger.totals.billedTokens).toBe(3 * (335200 + 100));
    const cacheDead = computeFindings(messages, ledger).filter((f) => f.type === 'cache_dead');
    expect(cacheDead).toHaveLength(1); // original round only
  });

  it('ghost runs are not copies; a copy after a ghost still matches its original', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(335200, 0, 0, 100) }),
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(0, 0, 0, 0) }), // ghost 1
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(0, 0, 0, 0) }), // ghost 2
      makeMsg({ type: 'assistant', model: 'glm-5.3-flash', usage: usage(335200, 0, 0, 100) }), // copy after ghosts
    ];
    const ledger = buildLedger(messages);
    // ghosts never match the all-zero pattern against a non-zero anchor
    expect(ledger.totals.noUsageRounds).toBe(2);
    expect(ledger.totals.retryCopies).toBe(1); // only the re-logged copy
    const cacheDead = computeFindings(messages, ledger).filter((f) => f.type === 'cache_dead');
    expect(cacheDead).toHaveLength(1); // copy after ghosts is still suppressed
  });

  it('skips re-logged copy tool calls in duplicate/failed/oversized findings', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'glm-5.3-flash',
        requestId: 'r1', // original was logged with a requestId
        usage: usage(335200, 0, 0, 100),
        toolCalls: [{ id: 't1', name: 'Bash', input: { command: 'pytest -q' }, isTask: false }],
      }),
      makeMsg({
        type: 'assistant',
        model: 'glm-5.3-flash', // copy: no requestId, identical counters
        usage: usage(335200, 0, 0, 100),
        toolCalls: [
          { id: 't1-copy', name: 'Bash', input: { command: 'pytest -q' }, isTask: false },
        ],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        toolResults: [{ toolUseId: 't1', content: 'ok', isError: false }],
      }),
    ];
    const duplicates = computeFindings(messages, buildLedger(messages)).filter(
      (f) => f.type === 'duplicate_call'
    );
    expect(duplicates).toHaveLength(0); // the copy's call is not a real repeat
  });
});

describe('long turns and loop streaks', () => {
  const at = (min: number): Date => new Date(Date.UTC(2026, 8, 20, 10, min));
  const call = (id: string, command = 'true') => ({
    id,
    name: 'Bash',
    input: { command },
    isTask: false,
  });
  const ok = (id: string) => ({ toolUseId: id, content: 'ok', isError: false });
  const err = (id: string) => ({ toolUseId: id, content: 'Error: boom', isError: true });

  it('flags back-to-back identical calls as a no-op loop streak', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        usage: usage(10, 0, 0, 1),
        toolCalls: [call('a1'), call('a2'), call('a3'), call('a4')],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        toolResults: [ok('a1'), ok('a2'), ok('a3'), ok('a4')],
      }),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    const streak = findings.find((f) => f.type === 'loop_streak');
    expect(streak).toBeDefined();
    expect(streak?.severity).toBe('medium'); // x4 — the shared LOOP_MIN_STREAK gate, high is x5+
    expect(streak?.summary).toContain('x4 back-to-back (no-op loop)');
    expect(streak?.tokensWasted).toBe(3 * estimateTokens('ok')); // repeats only
  });

  it('a 2-call series stays below the shared loop gate', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        usage: usage(10, 0, 0, 1),
        toolCalls: [call('a1'), call('a2')],
      }),
      makeMsg({ type: 'user', isMeta: true, toolResults: [ok('a1'), ok('a2')] }),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    expect(findings.filter((f) => f.type === 'loop_streak')).toHaveLength(0); // legit iteration
  });

  it('a streak where every result is an error is an env loop', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        usage: usage(10, 0, 0, 1),
        toolCalls: [call('b1'), call('b2'), call('b3'), call('b4'), call('b5')],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        toolResults: [err('b1'), err('b2'), err('b3'), err('b4'), err('b5')],
      }),
    ];
    const env = computeFindings(messages, buildLedger(messages)).find(
      (f) => f.type === 'loop_streak'
    );
    expect(env?.summary).toContain('env loop');
    expect(env?.severity).toBe('high'); // x5
  });

  it('calls separated by a different call do not form a streak', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        usage: usage(10, 0, 0, 1),
        toolCalls: [call('c1'), call('c2', 'ls -la'), call('c3'), call('c4')],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        toolResults: [ok('c1'), ok('c2'), ok('c3'), ok('c4')],
      }),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    expect(findings.filter((f) => f.type === 'loop_streak')).toHaveLength(0);
    expect(findings.some((f) => f.type === 'duplicate_call')).toBe(true);
  });

  it('retry copies do not grow a streak', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'glm-5.3-flash',
        requestId: 'r1', // original was logged with a requestId
        usage: usage(335200, 0, 0, 100),
        toolCalls: [call('t1')],
      }),
      makeMsg({
        type: 'assistant',
        model: 'glm-5.3-flash', // copy: no requestId, identical counters
        usage: usage(335200, 0, 0, 100),
        toolCalls: [call('t1-copy')],
      }),
      makeMsg({
        type: 'user',
        isMeta: true,
        toolResults: [ok('t1'), ok('t1-copy')],
      }),
    ];
    const streaks = computeFindings(messages, buildLedger(messages)).filter(
      (f) => f.type === 'loop_streak'
    );
    expect(streaks).toHaveLength(0); // the copy's call is skipped from the walk
  });

  it('successive different edits of one file are edits, not a loop (#90)', () => {
    const edit = (id: string, to: string) => ({
      id,
      name: 'Edit',
      input: { file_path: '/plan.md', old_string: `old-${to}`, new_string: `new-${to}` },
      isTask: false,
    });
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      makeMsg({
        type: 'assistant',
        model: 'm1',
        usage: usage(10, 0, 0, 1),
        toolCalls: [edit('e1', 'a'), edit('e2', 'b'), edit('e3', 'c')],
      }),
      makeMsg({ type: 'user', isMeta: true, toolResults: [ok('e1'), ok('e2'), ok('e3')] }),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    expect(findings.filter((f) => f.type === 'loop_streak')).toHaveLength(0);
    expect(findings.filter((f) => f.type === 'duplicate_call')).toHaveLength(0);
  });

  it('a dense turn (gaps under the idle cap) is flagged long_turn', () => {
    const messages = [
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
    const ledger = buildLedger(messages);
    const long = computeFindings(messages, ledger).find((f) => f.type === 'long_turn');
    expect(long).toBeDefined();
    expect(long?.severity).toBe('high');
    expect(long?.turnIndex).toBe(1);
    expect(long?.tokensWasted).toBe(0); // observation, not waste — unlike other findings
    expect(ledger.turns[0].activeMinutes).toBe(65); // 13 gaps × 5 min, под капом
    expect(ledger.totals.longestTurn?.activeMinutes).toBe(65);
  });

  it('idle-heavy turns stay under the flag (anti-noise regression)', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go', timestamp: at(0) }),
      makeMsg({ type: 'assistant', model: 'm1', timestamp: at(0), usage: usage(10, 0, 0, 1) }),
      makeMsg({ type: 'assistant', model: 'm1', timestamp: at(35), usage: usage(10, 0, 0, 1) }),
      makeMsg({ type: 'assistant', model: 'm1', timestamp: at(40), usage: usage(10, 0, 0, 1) }),
    ];
    const ledger = buildLedger(messages);
    expect(computeFindings(messages, ledger).some((f) => f.type === 'long_turn')).toBe(false);
    expect(ledger.turns[0].activeMinutes).toBe(15); // 10 (кап) + 5
  });

  it('filterLedgerByDate recomputes activeMinutes in the window', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go', timestamp: at(0) }),
      makeMsg({ type: 'assistant', model: 'm1', timestamp: at(0), usage: usage(10, 0, 0, 1) }),
      makeMsg({ type: 'assistant', model: 'm1', timestamp: at(35), usage: usage(10, 0, 0, 1) }),
      makeMsg({ type: 'assistant', model: 'm1', timestamp: at(40), usage: usage(10, 0, 0, 1) }),
    ];
    const ledger = filterLedgerByDate(buildLedger(messages), at(35));
    expect(ledger.turns[0].activeMinutes).toBe(5);
  });

  it('flags a turn of quiet expensive rounds as wait_loop', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go', timestamp: at(0) }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeMsg({
          type: 'assistant',
          model: 'm1',
          timestamp: at(i + 1),
          // distinct outputs: identical counters would read as router-retry copies
          usage: usage(60_000, 0, 0, 100 + i), // tick: 60k billed, ~100 out
        })
      ),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    const wait = findings.find((f) => f.type === 'wait_loop');
    expect(wait).toBeDefined();
    expect(wait?.severity).toBe('medium'); // 5 ticks — not yet a night watch
    expect(wait?.tokensWasted).toBe(5 * 60_000);
  });

  it('needs 5 ticks: loud rounds and retry copies do not count', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      // 4 real ticks, distinct outputs so they don't match each other as copies
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(60_000, 0, 0, 100) }),
      // a router-retry copy of tick 1 — identical counters, no requestId → skipped
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(60_000, 0, 0, 100) }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(60_000, 0, 0, 101) }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(60_000, 0, 0, 102) }),
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(60_000, 0, 0, 103) }),
      // a loud round: 400 tok of output — not a tick
      makeMsg({ type: 'assistant', model: 'm1', usage: usage(60_000, 0, 0, 400) }),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    expect(findings.some((f) => f.type === 'wait_loop')).toBe(false);
  });

  // live regression: session 0779a2bc — a reviewer emitted Bash(echo w), Bash(echo v),
  // Bash(echo u)... every round re-read ~134k context and grew it by the ~24-tok
  // tool result only; distinct args mean the repeat-key walk sees no streak
  it('flags a stall streak: tool rounds with no context growth (echo-marker loop)', () => {
    const base = 134_200;
    // context grows by exactly the tool result (+24) each round; inputs/outputs
    // differ so the router retry-copy filter does not swallow rounds
    const echoUsage = (i: number) => usage(100 + i, base + 24 * (i + 1) - (100 + i), 0, 19 + i);
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      // baseline round: real work — context jumps to `base`, loud output
      makeMsg({
        type: 'assistant',
        model: 'glm-5.3-flash',
        usage: usage(200, 134_000, 0, 2_000),
        toolCalls: [call('e0', 'cat plan.md')],
      }),
      makeMsg({ type: 'user', isMeta: true, toolResults: [ok('e0')] }),
      ...Array.from({ length: 4 }, (_, i) =>
        makeMsg({
          type: 'assistant',
          model: 'glm-5.3-flash',
          usage: echoUsage(i),
          toolCalls: [call(`e${i + 1}`, `echo ${String.fromCharCode(119 + i)}`)],
        })
      ),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    const stall = findings.find((f) => f.type === 'stall_streak');
    expect(stall).toBeDefined();
    expect(stall?.severity).toBe('medium'); // x4 — not yet a hang
    expect(stall?.turnIndex).toBe(1);
    // each stalled round re-read its full context — that is the burn
    const stalledContexts = [1, 2, 3, 4].map((k) => base + 24 * k);
    expect(stall?.tokensWasted).toBe(stalledContexts.reduce((s, c) => s + c, 0));
  });

  it('working rounds with real context growth are not a stall streak', () => {
    const messages = [
      makeMsg({ type: 'user', content: 'go' }),
      ...Array.from({ length: 5 }, (_, i) =>
        makeMsg({
          type: 'assistant',
          model: 'glm-5.3-flash',
          usage: usage(500, 100_000 + 2_000 * i, 0, 150 + i), // +2k context per round
          toolCalls: [call(`w${i}`, `edit file${i}.ts`)],
        })
      ),
    ];
    const findings = computeFindings(messages, buildLedger(messages));
    expect(findings.some((f) => f.type === 'stall_streak')).toBe(false);
  });
});
