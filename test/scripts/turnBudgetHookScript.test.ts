import { describe, expect, it, vi } from 'vitest';

// plain-node hook script — typed via scripts/turn-budget-hook.d.mts
import {
  analyzeTurn,
  billedRequestKey,
  billedTotalTokens,
  firstAssistantTotalTokens,
  inputSideTokens,
  isRealUserLine,
  lastAssistantTotalTokens,
  readConfig,
} from '../../scripts/turn-budget-hook.mjs';

// canonical boundary predicate + tag list (same core, direct file)
import { isUserChunkLine, SYSTEM_OUTPUT_TAGS } from '../../scripts/turn-accounting.mjs';

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

describe('accounting primitives (canonical core)', () => {
  it('splits input-side vs billed-total; walks first/last assistant usage', () => {
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 50,
      output_tokens: 25,
    };
    expect(inputSideTokens(usage)).toBe(350);
    expect(billedTotalTokens(usage)).toBe(375);
    expect(inputSideTokens(undefined)).toBe(0);

    const responses = [
      { type: 'user' },
      { type: 'assistant', usage },
      { type: 'assistant' }, // ghost round: no usage — skipped by the walkers
      { type: 'assistant', usage: { ...usage, output_tokens: 5 } },
    ];
    expect(firstAssistantTotalTokens(responses)).toBe(375);
    expect(lastAssistantTotalTokens(responses)).toBe(355);
    expect(firstAssistantTotalTokens([])).toBe(0);
  });

  it('billedRequestKey prefers requestId, then messageId, then message.id', () => {
    expect(billedRequestKey({ requestId: 'r', messageId: 'm', message: { id: 'x' } })).toBe('r');
    expect(billedRequestKey({ messageId: 'm', message: { id: 'x' } })).toBe('m');
    expect(billedRequestKey({ message: { id: 'x' } })).toBe('x');
    expect(billedRequestKey({})).toBeUndefined();
  });
});

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

describe('isUserChunkLine — canonical turn-boundary predicate', () => {
  const userLine = (content: unknown, isMeta = false): Record<string, unknown> => ({
    type: 'user',
    isMeta,
    message: { role: 'user', content },
  });

  it('plain text starts a turn (string and array forms)', () => {
    expect(isUserChunkLine(userLine('go'))).toBe(true);
    expect(isUserChunkLine(userLine([{ type: 'text', text: 'go' }]))).toBe(true);
    expect(isUserChunkLine(userLine([{ type: 'image', source: {} }]))).toBe(true);
  });

  it('system output tags never start a turn', () => {
    for (const tag of SYSTEM_OUTPUT_TAGS) {
      expect(isUserChunkLine(userLine(`${tag}done`))).toBe(false);
      expect(isUserChunkLine(userLine([{ type: 'text', text: `${tag}done` }]))).toBe(false);
    }
  });

  it('teammate relays with teammate_id never start a turn', () => {
    expect(
      isUserChunkLine(userLine('<teammate-message teammate_id="a">yo</teammate-message>'))
    ).toBe(false);
    expect(
      isUserChunkLine(userLine([{ type: 'text', text: '<teammate-message teammate_id="a">hi' }]))
    ).toBe(false);
  });

  it('<command-name> is user-initiated and DOES start a turn', () => {
    expect(isUserChunkLine(userLine('<command-name>/model</command-name> sonnet'))).toBe(true);
  });

  it('a lone interrupt text block does not start a turn', () => {
    expect(
      isUserChunkLine(userLine([{ type: 'text', text: '[Request interrupted by user]' }]))
    ).toBe(false);
    expect(
      isUserChunkLine(
        userLine([{ type: 'text', text: '[Request interrupted by user for tool use]' }])
      )
    ).toBe(false);
  });

  it('interruption text mixed with real content still counts', () => {
    expect(
      isUserChunkLine(
        userLine([
          { type: 'text', text: '[Request interrupted by user]' },
          { type: 'text', text: 'actually do this' },
        ])
      )
    ).toBe(true);
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
