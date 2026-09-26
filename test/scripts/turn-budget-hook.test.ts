import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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

describe('turn-budget-hook entry point', () => {
  it.each(['requestId', 'message.id'])('bills streamed %s usage once when run by Node', (key) => {
    const home = mkdtempSync(join(tmpdir(), 'turn-budget-hook-'));
    try {
      const configDir = join(home, '.claude');
      mkdirSync(configDir);
      writeFileSync(
        join(configDir, 'claude-devtools-config.json'),
        JSON.stringify({
          notifications: { turnBudget: { enabled: true, maxInputTokensPerTurn: 15_000_000 } },
        })
      );
      const transcript = join(home, 'session.jsonl');
      const runHook = (lines: string[]): string => {
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
      };
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
