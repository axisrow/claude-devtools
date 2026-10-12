/**
 * Tests for the sessions inventory CLI flags (src/cli/sessionInventory.ts):
 * unified flag grammar (--since/--until/--last N/--breakdown/--no-cost) and
 * per-model token accumulation feeding --breakdown.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { buildLedger } from '../../../src/cli/analyzeSession';
import { inDateRange, parseDayBound } from '../../../src/cli/args';
import { parseInventoryArgs, scanSessionFile } from '../../../src/cli/sessionInventory';
import { analyzeSessionFileMetadata, parseJsonlFile } from '../../../src/main/utils/jsonl';

describe('GLM fragment request without requestId (issue #95)', () => {
  // proxy (GLM via router) writes one API request as several JSONL lines with
  // one message.id and full usage on each — all three consumers must bill it once
  it('bills a multi-line request with one message.id once in every consumer', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-glm-'));
    try {
      const file = path.join(dir, 'session-glm.jsonl');
      const frag = (uuid: string, ts: string, text: string): string =>
        JSON.stringify({
          type: 'assistant',
          uuid,
          timestamp: ts,
          message: {
            id: 'msg_A',
            model: 'glm-5',
            content: [{ type: 'text', text }],
            usage: {
              input_tokens: 0,
              cache_read_input_tokens: 100_000,
              cache_creation_input_tokens: 0,
              output_tokens: 50,
            },
          },
        });
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-10-01T07:00:00Z',
          message: { role: 'user', content: 'go' },
        }),
        frag('a1', '2026-10-01T07:00:20Z', 'часть 1'),
        frag('a2', '2026-10-01T07:00:40Z', 'часть 2'),
      ];
      await writeFile(file, lines.join('\n') + '\n');

      const sidebar = (await analyzeSessionFileMetadata(file)).totalTokens;
      const totals = buildLedger(await parseJsonlFile(file)).totals;
      const ledgerTotal =
        totals.inputTokens +
        totals.cacheReadTokens +
        totals.cacheCreationTokens +
        totals.outputTokens;
      const inventory = (await scanSessionFile(file))?.totalTokens;

      // one request = one message = one round: 100k context read + 50 out, once
      expect(sidebar).toBe(100_050);
      expect(ledgerTotal).toBe(100_050);
      expect(inventory).toBe(100_050);
      // --breakdown counts the request once too
      expect((await scanSessionFile(file))?.tokensByModel).toEqual({ 'glm-5': 100_050 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseInventoryArgs (unified grammar)', () => {
  it('has ccusage-compatible defaults', () => {
    const o = parseInventoryArgs([]);
    expect(o.minMinutes).toBe(0);
    expect(o.sort).toBe('duration');
    expect(o.limit).toBe(Number.POSITIVE_INFINITY);
    expect(o.json).toBe(false);
    expect(o.breakdown).toBe(false);
    expect(o.since).toBeUndefined();
    expect(o.until).toBeUndefined();
    expect(o.error).toBeUndefined();
  });

  it('parses the full unified flag set', () => {
    const o = parseInventoryArgs([
      '--project',
      'p',
      '--min-minutes',
      '30',
      '--sort',
      'tokens',
      '--limit',
      '5',
      '--breakdown',
      '--no-cost',
      '--json',
      '--since',
      '2026-09-01',
      '--until',
      '20260920',
    ]);
    expect(o.projectArg).toBe('p');
    expect(o.minMinutes).toBe(30);
    expect(o.sort).toBe('tokens');
    expect(o.limit).toBe(5);
    expect(o.breakdown).toBe(true);
    expect(o.json).toBe(true);
    expect(o.since).toEqual(new Date(2026, 8, 1));
    expect(o.until).toEqual(new Date(2026, 8, 20, 23, 59, 59, 999));
    expect(o.error).toBeUndefined();
  });

  it('rejects malformed dates and --last without a positive number', () => {
    expect(parseInventoryArgs(['--since', 'nah']).error).toContain('--since');
    expect(parseInventoryArgs(['--until', '2026-13-01']).error).toContain('--until');
    expect(parseInventoryArgs(['--last']).error).toContain('--last');
    expect(parseInventoryArgs(['--last', '--json']).error).toContain('--last');
    expect(parseInventoryArgs(['--last', '0']).error).toContain('--last');
  });

  it('snaps --last N to local midnight N-1 days back', () => {
    const midnight = (back: number): Date => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - back);
      return d;
    };
    expect(parseInventoryArgs(['--last', '1']).since).toEqual(midnight(0)); // today
    expect(parseInventoryArgs(['--last', '7']).since).toEqual(midnight(6));
  });
});

describe('parseDayBound / inDateRange', () => {
  it('parses dash and compact forms with inclusive end of day', () => {
    expect(parseDayBound('2026-09-01', false)).toEqual(new Date(2026, 8, 1));
    expect(parseDayBound('20260901', true)).toEqual(new Date(2026, 8, 1, 23, 59, 59, 999));
    expect(parseDayBound('nah', false)).toBeNull();
    expect(parseDayBound('2026-02-30', false)).toBeNull();
    expect(parseDayBound('', false)).toBeNull();
  });

  it('checks the range inclusively on both ends', () => {
    const since = new Date(2026, 8, 1);
    const until = new Date(2026, 8, 20, 23, 59, 59, 999);
    expect(inDateRange(new Date(2026, 8, 1), since, until)).toBe(true);
    expect(inDateRange(new Date(2026, 8, 20, 12, 0), since, until)).toBe(true);
    expect(inDateRange(new Date(2026, 7, 31), since, until)).toBe(false);
    expect(inDateRange(new Date(2024, 9, 1), since, until)).toBe(false);
    expect(inDateRange(new Date(2026, 8, 5))).toBe(true);
  });
});

describe('active time parity: analyze:session vs analyze:sessions (issue #91)', () => {
  // One file, both consumers: streaming snapshots (several lines per requestId)
  // inside one turn. The ledger anchors a round at the request's LAST line
  // (keep-last dedup), so the inventory must measure gap last(i-1) → last(i) —
  // generation time counts as API work — and round only the displayed total.
  it('reports the same active time and longest turn for the same file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-parity-'));
    try {
      const file = path.join(dir, 'session-parity.jsonl');
      const usageLine = (uuid: string, ts: string, requestId: string): string =>
        JSON.stringify({
          type: 'assistant',
          uuid,
          timestamp: ts,
          requestId,
          message: {
            model: 'claude-sonnet-5',
            content: [],
            usage: { input_tokens: 5, output_tokens: 1 },
          },
        });
      const userLine = (uuid: string, ts: string): string =>
        JSON.stringify({
          type: 'user',
          uuid,
          timestamp: ts,
          message: { role: 'user', content: 'go' },
        });
      // turn 1: r1 10:00→10:01:30, r2 10:03→10:04:30, r3 10:06→10:06:30 →
      // gaps last→last: 3 min + 2 min = 5 min; turn 2: r4 10:09→r5 10:10:45
      // → 1.75 min (per-turn rounding would make it 2)
      const lines = [
        userLine('u1', '2026-09-20T09:59:00Z'),
        usageLine('a1', '2026-09-20T10:00:00Z', 'r1'),
        usageLine('a2', '2026-09-20T10:01:30Z', 'r1'),
        usageLine('a3', '2026-09-20T10:03:00Z', 'r2'),
        usageLine('a4', '2026-09-20T10:04:30Z', 'r2'),
        usageLine('a5', '2026-09-20T10:06:00Z', 'r3'),
        usageLine('a6', '2026-09-20T10:06:30Z', 'r3'),
        userLine('u2', '2026-09-20T10:08:00Z'),
        usageLine('a7', '2026-09-20T10:09:00Z', 'r4'),
        usageLine('a8', '2026-09-20T10:10:45Z', 'r5'),
      ];
      await writeFile(file, lines.join('\n') + '\n');

      const ledger = buildLedger(await parseJsonlFile(file));
      const entry = await scanSessionFile(file);
      expect(entry).not.toBeNull();
      // identical active time: 6.75 min (no per-turn rounding before the sum)
      expect(ledger.activeMinutes * 60000).toBe(405000);
      expect(entry?.activeMs).toBe(ledger.activeMinutes * 60000);
      // identical longest turn: turn 1's 5 min
      expect(entry?.longestTurnMs).toBe(ledger.totals.longestTurn!.activeMinutes * 60000);
      expect(entry?.longestTurnMs).toBe(300000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('scanSessionFile tokensByModel', () => {
  it('splits tokens per model, keeping synthetic and sidechain out', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-tbm-'));
    try {
      const file = path.join(dir, 'session1.jsonl');
      const lines = [
        JSON.stringify({
          type: 'user',
          uuid: '1',
          timestamp: '2026-09-20T10:00:00Z',
          cwd: '/Users/x/tg-content-factory',
        }),
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
          message: { model: 'claude-haiku-4-5', usage: { input_tokens: 7 } },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: '5',
          timestamp: '2026-09-20T10:08:00Z',
          message: { model: '<synthetic>', usage: { input_tokens: 9 } },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: '6',
          timestamp: '2026-09-20T10:09:00Z',
          isSidechain: true,
          message: {
            model: 'claude-haiku-4-5',
            usage: { input_tokens: 500, output_tokens: 50 },
          },
        }),
      ];
      await writeFile(file, lines.join('\n'));

      const entry = await scanSessionFile(file);
      expect(entry).not.toBeNull();
      // r1 dedup keeps the last entry (out 5); haiku arrives without requestId
      expect(entry?.tokensByModel).toEqual({
        'claude-sonnet-5': 115,
        'claude-haiku-4-5': 7,
      });
      expect(entry?.models).toEqual(['claude-sonnet-5', 'claude-haiku-4-5']);
      expect(entry?.totalTokens).toBe(122);
      expect(entry?.messageCount).toBe(6);
      // API time: r1's two streaming snapshots (10:05, 10:06) anchor once — the
      // only gap is r1-last (10:06) → haiku (10:07); the intra-request minute
      // does not count (parity with analyze:session's one round per request)
      expect(entry?.activeMs).toBe(60000);
      // real path from the session's cwd, not the lossy dash-decode of the dir name
      expect(entry?.cwd).toBe('/Users/x/tg-content-factory');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('parses --sort turn and --min-turn-minutes', () => {
    expect(parseInventoryArgs(['--sort', 'turn']).sort).toBe('turn');
    expect(parseInventoryArgs(['--min-turn-minutes', '30']).minTurnMinutes).toBe(30);
  });

  it('parses --sort streak and --min-streak', () => {
    expect(parseInventoryArgs(['--sort', 'streak']).sort).toBe('streak');
    expect(parseInventoryArgs(['--min-streak', '25']).minStreak).toBe(25);
  });

  it('tracks topRepeat across assistant lines with streaming dedup', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-tr-'));
    try {
      const file = path.join(dir, 'session-tr.jsonl');
      const usageLine = (
        uuid: string,
        ts: string,
        requestId?: string,
        toolUse?: {
          id: string;
          command: string;
        }
      ): string =>
        JSON.stringify({
          type: 'assistant',
          uuid,
          timestamp: ts,
          ...(requestId ? { requestId } : {}),
          message: {
            model: 'claude-sonnet-5',
            usage: { input_tokens: 5 },
            content: toolUse
              ? [
                  {
                    type: 'tool_use',
                    id: toolUse.id,
                    name: 'Bash',
                    input: { command: toolUse.command },
                  },
                ]
              : [],
          },
        });
      const lines = [
        // one stem, four calls: three exact + one piped variant (merged by stem)
        usageLine('a1', '2026-09-20T10:00:00Z', 'r1', { id: 't1', command: 'git show abc' }),
        usageLine('a2', '2026-09-20T10:01:00Z', 'r1', { id: 't2', command: 'git show abc' }),
        usageLine('a3', '2026-09-20T10:02:00Z', undefined, {
          id: 't3',
          command: 'git show abc | wc -l',
        }),
        usageLine('a6', '2026-09-20T10:02:30Z', undefined, {
          id: 't4',
          command: 'git show abc | head -5',
        }),
        // streaming snapshot: same requestId + same toolUseId → counted once
        usageLine('a4', '2026-09-20T10:03:00Z', 'r9', { id: 'd1', command: 'ls -la' }),
        usageLine('a5', '2026-09-20T10:04:00Z', 'r9', { id: 'd1', command: 'ls -la' }),
      ];
      await writeFile(file, lines.join('\n'));
      const entry = await scanSessionFile(file);
      // a1,a2,a3,a6 share one stem back-to-back → one cycle of 4 (the shared LOOP gate)
      expect(entry?.cycles).toEqual([
        { key: 'Bash|git show abc', count: 4, startTs: '2026-09-20T10:00:00Z', toolUseId: 't4' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('caps idle gaps in activeMs', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-am-'));
    try {
      const file = path.join(dir, 'session-am.jsonl');
      const lines = [
        JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-09-20T10:00:00Z',
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 5 } },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a2',
          timestamp: '2026-09-20T10:35:00Z',
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 5 } },
        }),
        JSON.stringify({
          type: 'assistant',
          uuid: 'a3',
          timestamp: '2026-09-20T10:37:00Z',
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 5 } },
        }),
      ];
      await writeFile(file, lines.join('\n'));
      const entry = await scanSessionFile(file);
      // 35 min gap capped at 10, plus 2 min — not 37
      expect(entry?.activeMs).toBe(720000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('longestTurnMs resets at user-turn boundaries', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-lt-'));
    try {
      const file = path.join(dir, 'session-lt.jsonl');
      const userLine = (ts: string): string =>
        JSON.stringify({
          type: 'user',
          uuid: 'u',
          timestamp: ts,
          message: { role: 'user', content: 'go' },
        });
      const usageLine = (uuid: string, ts: string): string =>
        JSON.stringify({
          type: 'assistant',
          uuid,
          timestamp: ts,
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 5 } },
        });
      const lines = [
        usageLine('a1', '2026-09-20T10:00:00Z'), // implicit turn 1: 0 active
        userLine('2026-09-20T10:35:00Z'), // boundary
        usageLine('a2', '2026-09-20T10:37:00Z'),
        usageLine('a3', '2026-09-20T10:39:00Z'), // turn 2: 2 min active
        userLine('2026-09-20T10:41:00Z'), // boundary
        usageLine('a4', '2026-09-20T10:42:00Z'), // turn 3: 0 active
      ];
      await writeFile(file, lines.join('\n'));
      const entry = await scanSessionFile(file);
      expect(entry?.activeMs).toBe(120000); // only turn 2's gaps count
      expect(entry?.longestTurnMs).toBe(120000); // turn 2, not the sum across turns
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('array-content user messages split turns (faithful isParsedUserChunkMessage guard)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-ac-'));
    try {
      const file = path.join(dir, 'session-ac.jsonl');
      const usageLine = (uuid: string, ts: string): string =>
        JSON.stringify({
          type: 'assistant',
          uuid,
          timestamp: ts,
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 5 } },
        });
      const lines = [
        usageLine('a1', '2026-09-20T10:00:00Z'),
        usageLine('a2', '2026-09-20T10:01:00Z'), // turn 1: 1 min active
        // newer-format user turn: array content with a text block
        JSON.stringify({
          type: 'user',
          uuid: 'u2',
          timestamp: '2026-09-20T10:02:00Z',
          message: { role: 'user', content: [{ type: 'text', text: 'go again' }] },
        }),
        usageLine('a3', '2026-09-20T10:10:00Z'), // turn 2: 0 active
      ];
      await writeFile(file, lines.join('\n'));
      const entry = await scanSessionFile(file);
      expect(entry?.activeMs).toBe(60000); // turn 1 only; turn 2 has a single round
      expect(entry?.longestTurnMs).toBe(60000); // not the uncapped merge (10 min)
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('local-command-stdout lines do not split turns', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-so-'));
    try {
      const file = path.join(dir, 'session-so.jsonl');
      const usageLine = (uuid: string, ts: string): string =>
        JSON.stringify({
          type: 'assistant',
          uuid,
          timestamp: ts,
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 5 } },
        });
      const lines = [
        usageLine('a1', '2026-09-20T10:00:00Z'),
        // bash-mode command output: type user, string content, falsy isMeta —
        // must NOT be a boundary (buildLedger does not split here either)
        JSON.stringify({
          type: 'user',
          uuid: 'u1',
          timestamp: '2026-09-20T10:01:00Z',
          message: {
            role: 'user',
            content: '<local-command-stdout>done</local-command-stdout>',
          },
        }),
        usageLine('a2', '2026-09-20T10:02:00Z'), // same turn: 2 min total
      ];
      await writeFile(file, lines.join('\n'));
      const entry = await scanSessionFile(file);
      expect(entry?.activeMs).toBe(120000); // 10:00→10:02, the stdout line did not reset
      expect(entry?.longestTurnMs).toBe(120000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('distinguishes cycles from scattered repeats', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-sc-'));
    try {
      const file = path.join(dir, 'session-sc.jsonl');
      const line = (uuid: string, n: number, command: string): string =>
        JSON.stringify({
          type: 'assistant',
          uuid,
          timestamp: `2026-09-20T10:0${n}:00Z`,
          message: {
            model: 'claude-sonnet-5',
            usage: { input_tokens: 5 },
            content: [{ type: 'tool_use', id: uuid, name: 'Bash', input: { command } }],
          },
        });
      // A,A,B,A,A,A,A — repeat(A)=6 but the longest back-to-back run is 4
      const lines = [
        line('a1', 0, 'probe one'),
        line('a2', 1, 'probe one'),
        line('a3', 2, 'git show xyz'),
        line('a4', 3, 'probe one'),
        line('a5', 4, 'probe one'),
        line('a6', 5, 'probe one'),
        line('a7', 6, 'probe one'),
      ];
      await writeFile(file, lines.join('\n'));
      const entry = await scanSessionFile(file);
      // A appears 6 times total, but only its 4-run qualifies as a cycle
      expect(entry?.cycles).toEqual([
        { key: 'Bash|probe one', count: 4, startTs: '2026-09-20T10:03:00Z', toolUseId: 'a7' },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
