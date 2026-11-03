import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  aggregate,
  collect,
  mergeApiErrors,
  parseApiErrorKey,
  parseExitCode,
  percentiles,
  scanSessionToolStats,
  type SessionToolStats,
  type ToolStat,
} from '../../src/cli/toolStats';

// =============================================================================
// percentiles
// =============================================================================

describe('percentiles', () => {
  it('interpolates p5/p50/p95 (numpy-style)', () => {
    expect(percentiles([1, 2, 3, 4, 50])).toEqual({ p5: 1.2, p50: 3, p95: 40.79999999999999 });
  });

  it('returns null for empty samples and passthrough for single value', () => {
    expect(percentiles([])).toBeNull();
    expect(percentiles([7])).toEqual({ p5: 7, p50: 7, p95: 7 });
  });
});

// =============================================================================
// parseExitCode / parseApiErrorKey
// =============================================================================

describe('parseExitCode', () => {
  it('prefers the structured toolUseResult.exitCode', () => {
    expect(parseExitCode({ exitCode: 3 }, 'Exit code 1')).toBe('3');
  });

  it('falls back to result text ("Exit code 1" / "Exit code: 2")', () => {
    expect(parseExitCode(undefined, 'boom\nExit code 1')).toBe('1');
    expect(parseExitCode(undefined, [{ type: 'text', text: 'nope\nExit code: 2' }])).toBe('2');
  });

  it('returns null when no code is present', () => {
    expect(parseExitCode({ stdout: 'ok' }, 'all good')).toBeNull();
    expect(parseExitCode('User rejected tool use', '')).toBeNull();
  });
});

describe('parseApiErrorKey', () => {
  it('normalizes the text after "API Error:"', () => {
    expect(parseApiErrorKey('API Error: The response stopped arriving.')).toBe(
      'The response stopped arriving.'
    );
  });

  it('returns null for non-API-error text and truncates long keys', () => {
    expect(parseApiErrorKey('(no content)')).toBeNull();
    expect(parseApiErrorKey(`API Error: ${'x'.repeat(300)}`)).toHaveLength(120);
  });

  it('collapses per-event noise: hex ids, embedded JSON, timestamps', () => {
    expect(
      parseApiErrorKey(
        'API Error: Request rejected (429) · [1302][Rate limit reached for requests][2026110213571060c9d602c57ab]'
      )
    ).toBe('Request rejected (429) · [1302][Rate limit reached for requests][<id>]');
    expect(
      parseApiErrorKey(
        'API Error: 400 litellm.BadRequestError: ChatgptException - {"error":{"msg"}}'
      )
    ).toBe('400 litellm.BadRequestError: ChatgptException - {…}');
    // multiline JSON payloads collapse too
    expect(
      parseApiErrorKey('API Error: 400 litellm.BadRequestError: X - {\n"detail": "boom"\n}')
    ).toBe('400 litellm.BadRequestError: X - {…}');
    expect(parseApiErrorKey('API Error: paused at 2026-10-05T13:42:54.892Z')).toBe(
      'paused at <ts>'
    );
  });
});

describe('mergeApiErrors', () => {
  it('sums count and byText in place', () => {
    const target = { count: 2, byText: { a: 1, b: 1 } };
    mergeApiErrors(target, { count: 3, byText: { b: 2, c: 1 } });
    expect(target).toEqual({ count: 5, byText: { a: 1, b: 3, c: 1 } });
  });
});

// =============================================================================
// collect: subagent transcript errors merge into the parent session
// =============================================================================

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

const syntheticApiError = (ts: string): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    isSidechain: true,
    message: {
      model: '<synthetic>',
      content: [
        {
          type: 'text',
          text: 'API Error: The response stopped arriving. The response above may be incomplete.',
        },
      ],
    },
  });

describe('collect', () => {
  it('merges api errors from <sessionId>/subagents (flat + nested) into the parent, tools not duplicated', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-stats-collect-'));
    try {
      const proj = path.join(root, '-test-project');
      const saDir = path.join(proj, SESSION_ID, 'subagents');
      const wfDir = path.join(saDir, 'workflows', 'wf_1');
      fs.mkdirSync(wfDir, { recursive: true });
      fs.writeFileSync(
        path.join(proj, `${SESSION_ID}.jsonl`),
        [
          assistantCall('tu1', 'Bash', { command: 'ls' }, '2026-10-20T10:00:00.000Z'),
          toolResult('tu1', 'out', '2026-10-20T10:00:01.000Z'),
        ].join('\n') + '\n'
      );
      fs.writeFileSync(
        path.join(saDir, 'agent-abc.jsonl'),
        syntheticApiError('2026-10-20T11:00:00.000Z') + '\n'
      );
      fs.writeFileSync(
        path.join(wfDir, 'agent-def.jsonl'),
        syntheticApiError('2026-10-20T12:00:00.000Z') + '\n'
      );
      // second project: parent without a subagents dir — error count stays 0
      const emptyProj = path.join(root, '-empty-project');
      fs.mkdirSync(emptyProj, { recursive: true });
      fs.writeFileSync(
        path.join(emptyProj, '99999999-8888-7777-6666-555555555555.jsonl'),
        assistantCall('tu2', 'Read', { file_path: '/a' }, '2026-10-20T10:00:00.000Z') + '\n'
      );

      const sessions = await collect(root);
      expect(sessions).toHaveLength(2);
      const s = sessions.find((x) => x.projectId === '-test-project');
      expect(s?.apiErrors.count).toBe(2);
      expect(Object.keys(s?.apiErrors.byText ?? {})).toEqual([
        'The response stopped arriving. The response above may be incomplete.',
      ]);
      // parent tool stats must not be double-counted from the subagent transcripts
      expect(s?.main.Bash?.calls).toBe(1);
      // parent without subagent transcripts keeps the count at zero
      expect(sessions.find((x) => x.projectId === '-empty-project')?.apiErrors.count).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// =============================================================================
// scanSessionToolStats on a synthetic JSONL
// =============================================================================

let tmpDir: string | null = null;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
});

const assistantCall = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  ts: string,
  sidechain = false
): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId: `r-${id}`,
    ...(sidechain ? { isSidechain: true } : {}),
    message: { model: 'claude-x', content: [{ type: 'tool_use', id, name, input }] },
  });

const toolResult = (callId: string, content: unknown, ts: string, isError = false): string =>
  JSON.stringify({
    type: 'user',
    timestamp: ts,
    message: {
      content: [{ type: 'tool_result', tool_use_id: callId, is_error: isError, content }],
    },
  });

const writeFixture = (lines: string[]): string => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-stats-test-'));
  const file = path.join(tmpDir, 'session-a.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

describe('scanSessionToolStats', () => {
  it('counts calls/results/errors/orphans, splits sidechain, parses exit codes and api errors', async () => {
    const file = writeFixture([
      // main chain: 3 Read (2 results + 1 orphan), 1 Bash error, 1 Task(Explore)
      assistantCall('tu1', 'Read', { file_path: '/a' }, '2026-10-20T10:00:00.000Z'),
      assistantCall('tu2', 'Read', { file_path: '/b' }, '2026-10-20T10:00:01.000Z'),
      assistantCall('tu3', 'Read', { file_path: '/c' }, '2026-10-20T10:00:02.000Z'),
      assistantCall('tu4', 'Bash', { command: 'false' }, '2026-10-20T10:00:03.000Z'),
      assistantCall(
        'tu5',
        'Task',
        { subagent_type: 'Explore', prompt: 'x' },
        '2026-10-20T10:00:04.000Z'
      ),
      // sidechain: 1 Bash with result
      assistantCall('tu6', 'Bash', { command: 'ls' }, '2026-10-20T10:00:05.000Z', true),
      // main-chain Task with no result — orphan must reach taskByType too
      assistantCall(
        'tu7',
        'Task',
        { subagent_type: 'Explore', prompt: 'y' },
        '2026-10-20T10:00:05.500Z'
      ),
      toolResult('tu1', 'data '.repeat(20), '2026-10-20T10:00:06.000Z'),
      toolResult('tu2', 'other', '2026-10-20T10:00:07.000Z'),
      toolResult('tu4', 'boom\nExit code 1', '2026-10-20T10:00:08.000Z', true),
      toolResult('tu5', 'explore result', '2026-10-20T10:00:09.000Z'),
      toolResult('tu6', 'file list\nExit code 0', '2026-10-20T10:00:10.000Z'),
      // synthetic API error (no tool blocks)
      syntheticApiError('2026-10-20T10:00:11.000Z'),
    ]);

    const s = await scanSessionToolStats(file);
    expect(s).not.toBeNull();
    if (!s) return;

    expect(s.main.Read).toMatchObject({ calls: 3, results: 2, errors: 0, orphanCalls: 1 });
    expect(s.main.Bash).toMatchObject({ calls: 1, results: 1, errors: 1 });
    expect(s.main.Task).toMatchObject({ calls: 2, results: 1, orphanCalls: 1 });
    expect(s.subagent.Bash).toMatchObject({ calls: 1, results: 1, errors: 0 });
    // sidechain calls stay out of the main-chain by-day counts
    expect(s.byDay['2026-10-20']).toEqual({
      Read: 3,
      Bash: 1,
      Task: 2,
    });
    expect(s.bashExitCodes).toEqual({ '0': 1, '1': 1 });
    expect(s.apiErrors.count).toBe(1);
    expect(Object.keys(s.apiErrors.byText)[0]).toContain('The response stopped arriving');
    // Task by subagent_type gets results/errors AND orphans — same invariant
    expect(s.taskByType.Explore).toMatchObject({ calls: 2, results: 1, orphanCalls: 1 });
    // invariant per tool
    for (const stat of [
      ...Object.values(s.main),
      ...Object.values(s.subagent),
      ...Object.values(s.taskByType),
    ]) {
      expect(stat.calls).toBe(stat.results + stat.orphanCalls);
      expect(stat.errors).toBeLessThanOrEqual(stat.results);
    }
  });

  it('returns null for a file without timestamps', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-stats-test-'));
    const file = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(file, 'not json\n{"type":"user"}\n');
    await expect(scanSessionToolStats(file)).resolves.toBeNull();
  });

  it('respects the call-level day-window', async () => {
    const file = writeFixture([
      assistantCall('tu1', 'Read', { file_path: '/a' }, '2026-10-01T10:00:00.000Z'),
      toolResult('tu1', 'old', '2026-10-01T10:00:01.000Z'),
      assistantCall('tu2', 'Read', { file_path: '/b' }, '2026-10-20T10:00:00.000Z'),
      toolResult('tu2', 'new', '2026-10-20T10:00:01.000Z'),
    ]);
    const s = await scanSessionToolStats(file, new Date(2026, 9, 10).getTime());
    expect(s).not.toBeNull();
    if (!s) return;
    // the pre-window call (and its result) is dropped entirely
    expect(s.main.Read).toMatchObject({ calls: 1, results: 1 });
    expect(Object.keys(s.byDay)).toEqual(['2026-10-20']);
  });
});

// =============================================================================
// aggregate: P5–P95 outliers
// =============================================================================

const makeSession = (
  projectId: string,
  sessionId: string,
  readCalls: number,
  apiErrCount = 0
): SessionToolStats => {
  const read: ToolStat = {
    calls: readCalls,
    results: readCalls,
    errors: 0,
    orphanCalls: 0,
    resultTokens: readCalls * 10,
    durationMs: 0,
  };
  return {
    projectId,
    sessionId,
    lastTs: new Date(2026, 9, 20),
    main: { Read: read },
    subagent: {},
    taskByType: {},
    byDay: {},
    bashExitCodes: {},
    apiErrors: { count: apiErrCount, byText: apiErrCount > 0 ? { boom: apiErrCount } : {} },
    toolDurationsMs: {},
  };
};

describe('aggregate outliers', () => {
  it('flags a session above P95 per tool and keeps the band median intact', () => {
    const sessions = [
      makeSession('p1', 's1', 2),
      makeSession('p1', 's2', 3),
      makeSession('p1', 's3', 3),
      makeSession('p1', 's4', 4),
      makeSession('p1', 's5', 50),
    ];
    const agg = aggregate(sessions);
    const outlier = agg.outliers.find(
      (o) => o.scope === 'session' && o.tool === 'Read' && o.metric === 'calls'
    );
    expect(outlier).toBeDefined();
    expect(outlier?.sessionId).toBe('s5');
    expect(outlier?.value).toBe(50);
    expect(outlier?.band.p50).toBe(3); // median of the four normal sessions
    expect(outlier?.band.p95).toBeCloseTo(40.79999999999999, 5);
  });

  it('project outlier mean divides by sessions that used the tool, not all project sessions', () => {
    const emptySession = { ...makeSession('p1', 's6', 10), main: {}, subagent: {} };
    const sessions = [
      makeSession('p1', 's1', 10),
      makeSession('p1', 's2', 10),
      makeSession('p1', 's3', 10),
      makeSession('p1', 's4', 10),
      makeSession('p1', 's5', 10),
      emptySession,
    ];
    const agg = aggregate(sessions);
    // 50 calls over 5 tool-sessions = mean 10 = the band itself — no outlier.
    // The old all-sessions divisor (50/6 ≈ 8.3) would flag a false below-P5 row.
    expect(agg.outliers.filter((o) => o.scope === 'project')).toHaveLength(0);
  });

  it('flags an api-error-heavy session and aggregates the error texts', () => {
    const sessions = [
      makeSession('p1', 's1', 2),
      makeSession('p1', 's2', 3),
      makeSession('p2', 's3', 3, 1),
      makeSession('p2', 's4', 4, 2),
      makeSession('p2', 's5', 3, 40),
    ];
    const agg = aggregate(sessions);
    const outlier = agg.outliers.find((o) => o.metric === 'apiErrors' && o.sessionId === 's5');
    expect(outlier).toBeDefined();
    expect(outlier?.value).toBe(40);
    expect(agg.apiErrors.count).toBe(43);
    expect(agg.apiErrors.byText.boom).toBe(43);
  });

  it('reports no bands for tools with fewer than MIN_SESSIONS_FOR_OUTLIERS samples', () => {
    const agg = aggregate([makeSession('p1', 's1', 2), makeSession('p1', 's2', 3)]);
    expect(agg.byToolPercentiles.Read).toBeUndefined();
    expect(agg.outliers).toHaveLength(0);
  });
});
