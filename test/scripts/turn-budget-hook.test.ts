import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// plain-node hook script — typed via scripts/turn-budget-hook.d.mts
import { analyzeTurn, deliveredDenyRounds } from '../../scripts/turn-budget-hook.mjs';

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
    ...(opts.requestId ? { requestId: opts.requestId } : {}),
    message: {
      id: opts.id,
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

/** Budget deny as Claude Code writes it back (probed on CC 2.1.302): an errored
 * tool_result "PreToolUse:<Tool> hook error: <reason>". */
function denyLine(
  toolUseId: string,
  opts: { isError?: boolean; sidechain?: boolean; text?: string } = {}
): string {
  return JSON.stringify({
    type: 'user',
    ...(opts.sidechain ? { isSidechain: true } : {}),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          is_error: opts.isError ?? true,
          content:
            opts.text ??
            'PreToolUse:Bash hook error: Turn input budget exhausted: ~15M / 15M tokens re-read this turn. Finish the turn now: report results and stop.',
        },
      ],
    },
  });
}

const COMPACT_LINE = JSON.stringify({
  type: 'user',
  isMeta: true,
  isCompactSummary: true,
  message: { content: [] },
});
const TASK_NOTIFICATION_LINE = JSON.stringify({
  type: 'user',
  message: { role: 'user', content: '<task-notification>mutmut finished</task-notification>' },
});
const SIDECHAIN_PROMPT_LINE = JSON.stringify({
  type: 'user',
  isSidechain: true,
  message: { role: 'user', content: 'subagent: scan the repo' },
});

describe('turn-budget-hook deliveredDenyRounds (stop-crane, #142)', () => {
  // newest-first, as linesBackward yields them
  const round = (id: string): string => usageLine({ id });

  it('counts a deny the model already saw: an older round was denied, a newer one calls again', () => {
    expect(deliveredDenyRounds([round('m2'), denyLine('t1'), round('m1'), USER_LINE])).toBe(1);
  });

  it("ignores denies newer than the newest round: its parallel siblings, the model hasn't seen them", () => {
    // m1 below was never denied: m2's sibling deny must not be booked on it
    expect(deliveredDenyRounds([denyLine('t2a'), round('m2'), round('m1'), USER_LINE])).toBe(0);
    // streamed fragments of one request may interleave with a sibling's result
    const interleaved = [round('m2'), denyLine('t2a'), round('m2'), round('m1'), USER_LINE];
    expect(deliveredDenyRounds(interleaved)).toBe(0);
  });

  it('counts denied rounds, not deny lines', () => {
    const lines = [
      round('m3'),
      denyLine('t2'),
      round('m2'),
      denyLine('t1b'),
      denyLine('t1a'),
      round('m1'),
      USER_LINE,
    ];
    expect(deliveredDenyRounds(lines)).toBe(2);
  });

  it('a real prompt starts a new run: earlier denies no longer count', () => {
    const lines = [round('m3'), USER_LINE, denyLine('t1'), round('m1'), USER_LINE];
    expect(deliveredDenyRounds(lines)).toBe(0);
  });

  it.each([
    ['compaction', COMPACT_LINE],
    ['task notification', TASK_NOTIFICATION_LINE],
    ['subagent prompt', SIDECHAIN_PROMPT_LINE],
  ])('a %s is no prompt: the run and its deny go on', (_, line) => {
    expect(deliveredDenyRounds([round('m2'), line, denyLine('t1'), round('m1'), USER_LINE])).toBe(
      1
    );
  });

  it('only errored main-chain tool_results are denies (a Read of the hook source is not)', () => {
    const notError = [round('m2'), denyLine('t1', { isError: false }), round('m1'), USER_LINE];
    const sidechain = [round('m2'), denyLine('t1', { sidechain: true }), round('m1'), USER_LINE];
    // a failed command that merely prints the marker (this repo's own tests) is no deny
    const printed = denyLine('t1', {
      text: 'Exit code 1\nAssertionError: expected "Turn input budget exhausted: ~15M" to be false',
    });
    expect(deliveredDenyRounds(notError)).toBe(0);
    expect(deliveredDenyRounds(sidechain)).toBe(0);
    expect(deliveredDenyRounds([round('m2'), printed, round('m1'), USER_LINE])).toBe(0);
  });
});

/** Temp HOME with a turn-budget config — the hook reads ~/.claude through HOME. */
function makeHome(budget: number): string {
  const home = mkdtempSync(join(tmpdir(), 'turn-budget-hook-'));
  mkdirSync(join(home, '.claude'));
  writeFileSync(
    join(home, '.claude', 'claude-devtools-config.json'),
    JSON.stringify({
      notifications: { turnBudget: { enabled: true, maxInputTokensPerTurn: budget } },
    })
  );
  return home;
}

/** Run the hook as Claude Code does: bare node, PreToolUse JSON on stdin. */
function spawnHook(home: string, lines: string[]): string {
  const transcript = join(home, 'session.jsonl');
  writeFileSync(transcript, lines.join('\n') + '\n');
  const result = spawnSync(process.execPath, [resolve('scripts/turn-budget-hook.mjs')], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
    timeout: 5_000,
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'test',
      transcript_path: transcript,
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
    }),
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout;
}

function withHome(budget: number, fn: (home: string) => void): void {
  const home = makeHome(budget);
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const readLog = (home: string): string =>
  readFileSync(join(home, '.claude', 'claude-devtools-turnbudget.log'), 'utf8');

describe('turn-budget-hook stop-crane entry point (#142)', () => {
  // over budget (1000): the model got a deny on m1 and still calls a tool in m2
  const ignoredDeny = [USER_LINE, usageLine({ id: 'm1' }), denyLine('t1'), usageLine({ id: 'm2' })];

  it('stops the run with continue:false once a tool is called after a delivered deny', () => {
    withHome(1_000, (home) => {
      const out = JSON.parse(spawnHook(home, ignoredDeny));
      expect(out.continue).toBe(false);
      expect(out.stopReason).toContain('stop-crane');
      // continue:false alone still runs the tool (probed on CC 2.1.302) — the deny must ride along
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(readLog(home)).toContain('kind=crane session=test');
    });
  });

  it('keeps the first deny soft: the old deny JSON, no continue key', () => {
    withHome(1_000, (home) => {
      const out = JSON.parse(spawnHook(home, [USER_LINE, usageLine({ id: 'm1' })]));
      expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(out).not.toHaveProperty('continue');
      expect(readLog(home)).toContain('kind=deny session=test');
    });
  });

  it('respects `budget off`: no deny, no crane', () => {
    withHome(1_000, (home) => {
      mkdirSync(join(home, '.claude', 'claude-devtools-turnbudget-off'));
      writeFileSync(join(home, '.claude', 'claude-devtools-turnbudget-off', 'test'), '');
      expect(spawnHook(home, ignoredDeny)).toBe('');
    });
  });
});

describe('turn-budget-hook entry point', () => {
  it.each(['requestId', 'message.id'])('bills streamed %s usage once when run by Node', (key) => {
    const home = makeHome(15_000_000);
    try {
      const configDir = join(home, '.claude');
      const runHook = (lines: string[]): string => spawnHook(home, lines);
      const fragments = Array.from({ length: 75 }, (_, i) =>
        [0, 1].map((fragment) =>
          usageLine({
            id: key === 'requestId' ? `m-${i}-${fragment}` : `m-${i}`,
            requestId: key === 'requestId' ? `req-${i}` : undefined,
            input: 1_000,
            cacheRead: 199_000,
          })
        )
      ).flat();

      // 40 requests cost 8M, not 16M: the old main() lost its dedup set per line.
      expect(runHook([USER_LINE, ...fragments.slice(0, 80)])).toBe('');

      // Still enforce the real budget, with the deduplicated total in the log.
      const denied = JSON.parse(runHook([USER_LINE, ...fragments]));
      expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(readFileSync(join(configDir, 'claude-devtools-turnbudget.log'), 'utf8')).toContain(
        'spent=15000000 budget=15000000 denied=true'
      );

      expect(runHook([USER_LINE, ...fragments, USER_LINE, ...fragments.slice(0, 80)])).toBe('');
      expect(runHook(fragments)).toBe(''); // Missing boundary must remain fail-open.
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
