/**
 * Tests for the sessions inventory CLI flags (src/cli/sessionInventory.ts):
 * unified flag grammar (--since/--until/--last N/--breakdown/--no-cost) and
 * per-model token accumulation feeding --breakdown.
 */
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { inDateRange, parseDayBound } from '../../../src/cli/args';
import { parseInventoryArgs, scanSessionFile } from '../../../src/cli/sessionInventory';

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

describe('scanSessionFile tokensByModel', () => {
  it('splits tokens per model, keeping synthetic and sidechain out', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'devtools-tbm-'));
    try {
      const file = path.join(dir, 'session1.jsonl');
      const lines = [
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
