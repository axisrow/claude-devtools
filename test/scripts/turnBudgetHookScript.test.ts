import { describe, expect, it, vi } from 'vitest';

// plain-node hook script — typed via scripts/turn-budget-hook.d.mts
import {
  analyzeTurn,
  billedRequestKey,
  billedTotalTokens,
  createRequestLedger,
  DEFAULT_TURN_BUDGET,
  firstAssistantTotalTokens,
  inputSideTokens,
  isRealUserLine,
  lastAssistantTotalTokens,
  MIN_TURN_BUDGET,
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
    expect(inputSideTokens()).toBe(0);

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
    ).toBe(true);
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

  it('complete teammate relays never start a turn; malformed wrappers stay user text (#59)', () => {
    expect(
      isUserChunkLine(userLine('<teammate-message teammate_id="a">yo</teammate-message>'))
    ).toBe(false);
    // unclosed wrapper — the strict parser cannot render it as a card either,
    // so it is preserved as user input rather than swallowed
    expect(
      isUserChunkLine(userLine([{ type: 'text', text: '<teammate-message teammate_id="a">hi' }]))
    ).toBe(true);
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
    expect(r).toEqual({ spent: 500, boundaryFound: true, boundaryId: null });
  });

  it('returns the boundary uuid as boundaryId — the turn identity for the bell edge-trigger', () => {
    const boundary = JSON.stringify({
      type: 'user',
      uuid: 'u-turn-9',
      message: { role: 'user', content: 'go' },
    });
    const r = analyzeTurn([assistantRaw(300), boundary, assistantRaw(9000)]);
    expect(r).toEqual({ spent: 300, boundaryFound: true, boundaryId: 'u-turn-9' });
  });

  it('stops at a compaction marker — pre-compact rounds do not count', () => {
    const r = analyzeTurn([assistantRaw(100), COMPACT_RAW, assistantRaw(777)]);
    expect(r).toEqual({ spent: 100, boundaryFound: true, boundaryId: null });
  });

  it('reports boundaryFound=false when no boundary exists', () => {
    const r = analyzeTurn([assistantRaw(50), assistantRaw(60)]);
    expect(r).toEqual({ spent: 110, boundaryFound: false, boundaryId: null });
  });

  // PR #27 review: a proxy stamping requestId on the head line only used to
  // fork the request into two keys (requestId vs message.id) and bill twice
  it('bills a mixed-shape request (head with requestId, bare fragments) once', () => {
    const head = JSON.stringify({
      type: 'assistant',
      requestId: 'req_1',
      message: { id: 'msg_1', usage: { input_tokens: 5000 } },
    });
    const fragment = JSON.stringify({
      type: 'assistant',
      message: { id: 'msg_1', usage: { input_tokens: 5000 } },
    });
    // newest-first: fragments arrive before the head
    const r = analyzeTurn([fragment, fragment, head, USER_RAW]);
    expect(r.spent).toBe(5000);
    expect(r.boundaryFound).toBe(true);
  });
});

describe('request ledger (canonical core)', () => {
  it('aliases bare message.id lines onto the head requestId, forward order', () => {
    const ledger = createRequestLedger();
    const head = { type: 'assistant', requestId: 'r1', message: { id: 'm1', usage: {} } };
    const frag = { type: 'assistant', message: { id: 'm1', usage: {} } };
    expect(ledger.bill(head, 1000)).toBe(true);
    expect(ledger.bill(frag, 1200)).toBe(false); // alias → replace, not add
    expect(ledger.bill({ type: 'assistant', message: { id: 'm2', usage: {} } }, 700)).toBe(true);
    expect(ledger.spent).toBe(1900);
  });

  it('moves a bare-id contribution onto the requestId when the head arrives later', () => {
    const ledger = createRequestLedger();
    const head = { type: 'assistant', requestId: 'r1', message: { id: 'm1', usage: {} } };
    const frag = { type: 'assistant', message: { id: 'm1', usage: {} } };
    expect(ledger.bill(frag, 800)).toBe(true); // billed under the bare id first
    expect(ledger.bill(head, 1000)).toBe(true); // head re-points and replaces
    expect(ledger.spent).toBe(1000);
    expect(ledger.bill(frag, 1100)).toBe(false); // now keyed by the alias
    expect(ledger.spent).toBe(1100);
  });
});

describe('hook readConfig', () => {
  it('reads the section, defaults when missing, survives garbage', () => {
    expect(
      readConfig(
        '{"notifications":{"turnBudget":{"enabled":false,"maxInputTokensPerTurn":150000}}}'
      )
    ).toEqual({
      enabled: false,
      budget: 150000,
      enforce: true,
    });
    expect(
      readConfig(
        '{"notifications":{"turnBudget":{"enabled":true,"maxInputTokensPerTurn":5,"enforce":false}}}'
      ).enforce
    ).toBe(false);
    expect(readConfig('{}').enabled).toBe(true);
    expect(readConfig('not json').budget).toBeGreaterThan(0);
    expect(readConfig().enabled).toBe(true);
  });

  // the hook reads the config file directly, bypassing IPC validation — a
  // hand-edited or corrupted 0/negative budget must not become deny-everything
  it('floors the budget: 0/negative reset to default, below-floor clamps to MIN', () => {
    expect(readConfig('{"notifications":{"turnBudget":{"maxInputTokensPerTurn":0}}}').budget).toBe(
      DEFAULT_TURN_BUDGET
    );
    expect(readConfig('{"notifications":{"turnBudget":{"maxInputTokensPerTurn":-5}}}').budget).toBe(
      DEFAULT_TURN_BUDGET
    );
    expect(
      readConfig('{"notifications":{"turnBudget":{"maxInputTokensPerTurn":50000}}}').budget
    ).toBe(MIN_TURN_BUDGET);
    expect(
      readConfig('{"notifications":{"turnBudget":{"maxInputTokensPerTurn":250000}}}').budget
    ).toBe(250000);
  });
});

describe('hook deny output shape', () => {
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
