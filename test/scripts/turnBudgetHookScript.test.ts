import { describe, expect, it, vi } from 'vitest';

// untyped plain-node hook script, imported directly
// @ts-expect-error .mjs without type declarations
import { analyzeTurn, isRealUserLine, readConfig } from '../../scripts/turn-budget-hook.mjs';

const USER_RAW = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } });
const COMPACT_RAW = JSON.stringify({
  type: 'user',
  isCompactSummary: true,
  message: { role: 'user', content: 'summary of previous context' },
});

function assistantRaw(input: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', usage: { input_tokens: input } },
  });
}

describe('hook isRealUserLine (raw JSONL shapes)', () => {
  it('recognizes a message-wrapped real user line — regression on the 872M bug', () => {
    expect(isRealUserLine(JSON.parse(USER_RAW))).toBe(true);
  });

  it('accepts legacy flat content and text/image arrays, rejects the rest', () => {
    expect(isRealUserLine({ type: 'user', content: 'legacy flat' })).toBe(true);
    expect(
      isRealUserLine({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }] } })
    ).toBe(true);
    expect(
      isRealUserLine({ type: 'user', isMeta: true, message: { content: 'tool result' } })
    ).toBe(false);
    expect(isRealUserLine({ type: 'user', message: { content: '' } })).toBe(false);
    expect(
      isRealUserLine({ type: 'user', message: { content: '[Request interrupted by user]' } })
    ).toBe(false);
    expect(
      isRealUserLine({ type: 'user', message: { content: '<teammate-message id="x">yo</...>' } })
    ).toBe(false);
    expect(isRealUserLine({ type: 'assistant', message: { content: 'hi' } })).toBe(false);
  });
});

describe('hook analyzeTurn', () => {
  it('sums assistants newest-first and stops at the user boundary', () => {
    const r = analyzeTurn([assistantRaw(300), assistantRaw(200), USER_RAW, assistantRaw(9000)]);
    expect(r).toEqual({ spent: 500, boundaryFound: true });
  });

  it('stops at a compaction marker — pre-compact rounds do not count', () => {
    const r = analyzeTurn([assistantRaw(100), COMPACT_RAW, assistantRaw(777)]);
    expect(r).toEqual({ spent: 100, boundaryFound: true });
  });

  it('reports boundaryFound=false when no boundary exists', () => {
    const r = analyzeTurn([assistantRaw(50), assistantRaw(60)]);
    expect(r).toEqual({ spent: 110, boundaryFound: false });
  });
});

describe('hook readConfig', () => {
  it('reads the section, defaults when missing, survives garbage', () => {
    expect(
      readConfig('{"notifications":{"turnBudget":{"enabled":false,"maxInputTokensPerTurn":42}}}')
    ).toEqual({
      enabled: false,
      budget: 42,
    });
    expect(readConfig('{}').enabled).toBe(true);
    expect(readConfig('not json').budget).toBeGreaterThan(0);
    expect(readConfig(undefined).enabled).toBe(true);
  });
});

describe('hook deny output shape', async () => {
  it('emits permissionDecision deny via stdout', async () => {
    const { deny } = await import('../../scripts/turn-budget-hook.mjs');
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    deny(16_000_000, 15_000_000);
    const payload = JSON.parse(String(write.mock.calls[0][0]));
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('15M');
    write.mockRestore();
  });
});
