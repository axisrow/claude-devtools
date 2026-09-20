/**
 * Tests for the token-analytics CLI (src/cli/*).
 * Covers the ported prototype logic: turn boundaries, requestId dedup,
 * duplicate-call keys, waste findings, slow-subagent math, inventory scan.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildLedger,
  computeFindings,
  detectBillingScheme,
  normalizeCallKey,
  priceFamily,
} from '../../../src/cli/analyzeSession';
import { scanSessionFile } from '../../../src/cli/sessionInventory';
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
    const types = computeFindings(messages, ledger).map((f) => f.type);

    expect(types).toContain('duplicate_call');
    expect(types).toContain('failed_call');
    const failed = computeFindings(messages, ledger).filter((f) => f.type === 'failed_call');
    expect(failed).toHaveLength(1); // only the real failure, not the rejection
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
  it('computes duration, dedups usage per requestId, excludes synthetic', async () => {
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
        ].join('\n')
      );

      const entry = await scanSessionFile(file);
      expect(entry).not.toBeNull();
      expect(entry?.durationMs).toBe(7 * 60 * 1000);
      expect(entry?.models).toEqual(['claude-sonnet-5']);
      expect(entry?.inputTokens).toBe(10);
      expect(entry?.outputTokens).toBe(5);
      expect(entry?.cacheReadTokens).toBe(100);
      expect(entry?.messageCount).toBe(4);
      expect(entry?.billing).toBe('router-style');
    } finally {
      await rm(dir, { recursive: true, force: true });
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
});
