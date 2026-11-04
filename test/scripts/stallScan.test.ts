import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  aggregate,
  collectStalls,
  parseStallScanArgs,
  scanFileForStalls,
  type StallIncident,
} from '../../src/cli/stallScan';

const MIN = 60_000;
const T0 = new Date('2026-11-04T02:00:00.000Z').getTime();
const GAP_MS = 10 * MIN;

const at = (ms: number): string => new Date(ms).toISOString();

const line = (tsMs: number, extra: object): string =>
  JSON.stringify({ timestamp: at(tsMs), ...extra });

const userLine = (tsMs: number, text = 'do the thing'): string =>
  line(tsMs, { type: 'user', isMeta: false, message: { role: 'user', content: text } });

const assistantLine = (
  tsMs: number,
  model: string,
  usage?: { input?: number; cacheRead?: number }
): string =>
  line(tsMs, {
    type: 'assistant',
    message: {
      model,
      content: [{ type: 'text', text: 'ok' }],
      usage: usage
        ? {
            input_tokens: usage.input ?? 0,
            cache_read_input_tokens: usage.cacheRead ?? 0,
            cache_creation_input_tokens: 0,
          }
        : undefined,
    },
  });

const systemEnd = (tsMs: number): string =>
  line(tsMs, { type: 'system', subtype: 'turn_duration', durationMs: 30_000 });

const queueLine = (tsMs: number): string =>
  line(tsMs, { type: 'queue-operation', operation: 'enqueue' });

const syntheticError = (tsMs: number, text: string): string =>
  line(tsMs, {
    type: 'assistant',
    message: { model: '<synthetic>', content: [{ type: 'text', text }] },
  });

// fixtures live under <root>/<project>/ so the path-derived projectId is realistic
const makeProj = (files: Record<string, string[]>): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-scan-'));
  const proj = path.join(root, 'p');
  fs.mkdirSync(proj);
  for (const [name, lines] of Object.entries(files)) {
    fs.writeFileSync(path.join(proj, name), lines.join('\n'));
  }
  return root;
};

const baseOpts = (root: string, nowMs = T0 + 8 * 60 * MIN) => ({
  minGapMs: GAP_MS,
  fileKind: 'main' as const,
  scanBase: root,
  nowMs,
});

const scan = (lines: string[], nowMs?: number): Promise<StallIncident[]> => {
  const root = makeProj({ 's.jsonl': lines });
  return scanFileForStalls(path.join(root, 'p', 's.jsonl'), baseOpts(root, nowMs));
};

// =============================================================================
// parseStallScanArgs
// =============================================================================

describe('parseStallScanArgs', () => {
  it('defaults: min-gap 10, sort minutes, limit 50', () => {
    expect(parseStallScanArgs([])).toEqual({
      minGapMinutes: 10,
      sort: 'minutes',
      limit: 50,
      json: false,
    });
  });

  it('parses flags and records arg errors', () => {
    const o = parseStallScanArgs([
      '--project',
      'x',
      '--min-gap',
      '30',
      '--sort',
      'start',
      '--limit',
      '5',
      '--json',
    ]);
    expect(o.projectArg).toBe('x');
    expect(o.minGapMinutes).toBe(30);
    expect(o.sort).toBe('start');
    expect(o.limit).toBe(5);
    expect(o.json).toBe(true);
    expect(o.error).toBeUndefined();

    expect(parseStallScanArgs(['--min-gap', 'nope']).error).toContain('--min-gap');
    expect(parseStallScanArgs(['--last', 'also-nope']).error).toContain('--last');
    expect(parseStallScanArgs(['--since', 'bad-date']).error).toContain('--since');
    expect(parseStallScanArgs(['--wat']).error).toContain('--wat');
  });

  it('--last maps onto since', () => {
    const o = parseStallScanArgs(['--last', '3']);
    expect(o.since).toBeInstanceOf(Date);
    expect(o.until).toBeUndefined();
  });
});

// =============================================================================
// scanFileForStalls
// =============================================================================

describe('scanFileForStalls', () => {
  it('flags a 3h mid-turn gap: resumed-continuation with cache-miss', async () => {
    const incidents = await scan([
      userLine(T0),
      assistantLine(T0 + MIN, 'glm-5.3-flash', { input: 1000, cacheRead: 50_000 }),
      queueLine(T0 + 3 * 60 * MIN),
      assistantLine(T0 + 3 * 60 * MIN + MIN, 'glm-5.3-flash', { input: 150_000, cacheRead: 1_000 }),
      systemEnd(T0 + 3 * 60 * MIN + 2 * MIN),
    ]);
    expect(incidents).toHaveLength(1);
    const inc = incidents[0];
    expect(inc.outcome).toBe('resumed-continuation');
    expect(inc.minutes).toBe(179); // 3h gap minus the 1m of prior activity
    expect(inc.cacheMissTokens).toBe(150_000);
    expect(inc.model).toBe('glm-5.3-flash');
    expect(inc.projectId).toBe('p');
    expect(inc.sessionId).not.toBe('');
  });

  it('first post-gap real user line: resumed-user, warm cache means no miss', async () => {
    const incidents = await scan([
      userLine(T0),
      assistantLine(T0 + MIN, 'glm', { input: 1000, cacheRead: 50_000 }),
      userLine(T0 + 2 * 60 * MIN),
      assistantLine(T0 + 2 * 60 * MIN + MIN, 'glm', { input: 500, cacheRead: 60_000 }),
      systemEnd(T0 + 2 * 60 * MIN + 2 * MIN),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].outcome).toBe('resumed-user');
    expect(incidents[0].cacheMissTokens).toBe(0);
  });

  it('flags truncated when the file ends non-system and stale; system end suppresses', async () => {
    const root = makeProj({
      's.jsonl': [userLine(T0), assistantLine(T0 + MIN)],
      'clean.jsonl': [userLine(T0), assistantLine(T0 + MIN), systemEnd(T0 + 2 * MIN)],
    });
    const stalled = await scanFileForStalls(path.join(root, 'p', 's.jsonl'), baseOpts(root));
    expect(stalled).toHaveLength(1);
    expect(stalled[0].outcome).toBe('truncated');
    expect(stalled[0].gapEndMs).toBeNull();

    expect(
      await scanFileForStalls(path.join(root, 'p', 'clean.jsonl'), baseOpts(root))
    ).toHaveLength(0);
  });

  it('api-error outcome for a synthetic carrier right after the gap', async () => {
    const incidents = await scan([
      userLine(T0),
      assistantLine(T0 + MIN, 'glm'),
      syntheticError(
        T0 + 3 * 60 * MIN,
        'API Error: Request rejected (429) · [1302][Rate limit][2026110213571060c9d602c57ab]'
      ),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].outcome).toBe('api-error');
    expect(incidents[0].errorKey).toBe('Request rejected (429) · [1302][Rate limit][<id>]');
  });

  it('gaps below the threshold are not incidents', async () => {
    const incidents = await scan([
      userLine(T0),
      assistantLine(T0 + 9 * MIN),
      systemEnd(T0 + 10 * MIN),
    ]);
    expect(incidents).toHaveLength(0);
  });

  it('backdated lines do not create phantom gaps (high-water mark)', async () => {
    const incidents = await scan([
      userLine(T0),
      assistantLine(T0 + 9 * MIN),
      queueLine(T0 + MIN), // backdated — must not extend the gap window
      assistantLine(T0 + 11 * MIN),
      systemEnd(T0 + 12 * MIN),
    ]);
    expect(incidents).toHaveLength(0);

    const control = await scan([
      userLine(T0),
      assistantLine(T0 + 9 * MIN),
      queueLine(T0 + 3 * 60 * MIN),
      systemEnd(T0 + 3 * 60 * MIN + MIN),
    ]);
    expect(control).toHaveLength(1);
    expect(control[0].outcome).toBe('resumed-continuation');
  });

  it('first qualifying post-gap usage wins', async () => {
    const incidents = await scan([
      userLine(T0),
      assistantLine(T0 + MIN, 'glm'),
      queueLine(T0 + 3 * 60 * MIN),
      assistantLine(T0 + 3 * 60 * MIN + MIN, 'glm', { input: 150_000, cacheRead: 1_000 }),
      assistantLine(T0 + 3 * 60 * MIN + 2 * MIN, 'glm', { input: 200_000, cacheRead: 0 }),
      systemEnd(T0 + 3 * 60 * MIN + 3 * MIN),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].cacheMissTokens).toBe(150_000);
  });
});

describe('aggregate', () => {
  it('collects closed-gap durations, wedge subset, and unclosed count', () => {
    const mk = (outcome: string, gapEndMs: number | null, minutes: number): StallIncident =>
      ({
        projectId: 'p',
        sessionId: 's',
        fileKind: 'main',
        gapStartMs: T0,
        gapEndMs,
        minutes,
        outcome,
        cacheMissTokens: 0,
      }) as StallIncident;
    const agg = aggregate([
      mk('resumed-user', T0 + 15 * MIN, 15),
      mk('resumed-continuation', T0 + 65 * MIN, 65),
      mk('api-error', T0 + 30 * MIN, 30),
      mk('truncated', null, 0),
    ]);
    expect(agg.durationsMinutes).toEqual([15, 65, 30]);
    expect(agg.wedgeDurationsMinutes).toEqual([65, 30]);
    expect(agg.unclosed).toBe(1);
    expect(agg.totalStallMinutes).toBe(110);
  });
});

// =============================================================================
// collectStalls: walker semantics
// =============================================================================

describe('collectStalls', () => {
  it('scans subagent files, skips flat agent-* duplicates', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-scan-collect-'));
    const proj = path.join(root, '-proj');
    fs.mkdirSync(proj);
    const gapLines = (): string[] => [
      userLine(T0),
      assistantLine(T0 + MIN, 'glm'),
      queueLine(T0 + 3 * 60 * MIN),
      systemEnd(T0 + 3 * 60 * MIN + MIN),
    ];

    fs.writeFileSync(path.join(proj, 'c.jsonl'), gapLines().join('\n'));
    // flat agent file duplicates the parent sidechain — walker skips it
    fs.writeFileSync(path.join(proj, 'agent-dup.jsonl'), gapLines().join('\n'));
    // subagent transcript scans as an independent file
    fs.mkdirSync(path.join(proj, 'sessionD', 'subagents'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, 'sessionD', 'subagents', 'agent-x.jsonl'),
      gapLines().join('\n')
    );

    const { incidents, scannedFiles } = await collectStalls(root, { minGapMs: GAP_MS });
    expect(incidents.some((i) => i.fileKind === 'main' && i.projectId === '-proj')).toBe(true);
    expect(incidents.some((i) => i.fileKind === 'subagent')).toBe(true);
    expect(incidents.filter((i) => i.sessionId === 'agent-dup')).toHaveLength(0);
    expect(scannedFiles).toBe(2);
    expect(aggregate(incidents).total).toBe(2);
  });
});
