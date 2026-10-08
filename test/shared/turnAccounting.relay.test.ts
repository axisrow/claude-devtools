import { describe, expect, it } from 'vitest';

// canonical accounting core (same file the hook imports through its wrapper)
import {
  isTeammateRelayLine,
  isTranscriptTurnLine,
  isUserChunkLine,
} from '../../scripts/turn-accounting.mjs';

const relayString = '<teammate-message teammate_id="a">yo</teammate-message>';

// raw JSONL shape: content wrapped in .message (hook feed lines)
const rawLine = (content: unknown, isMeta = false): Record<string, unknown> => ({
  type: 'user',
  isMeta,
  message: { role: 'user', content },
});
// flattened ParsedMessage shape (app parser): content directly on the object
const flatLine = (content: unknown, isMeta = false): Record<string, unknown> => ({
  type: 'user',
  isMeta,
  content,
});

describe('isTeammateRelayLine / isTranscriptTurnLine (issue #55)', () => {
  it('a relay line is a relay in string and array forms, raw and flat', () => {
    expect(isTeammateRelayLine(rawLine(relayString))).toBe(true);
    expect(isTeammateRelayLine(flatLine(relayString))).toBe(true);
    expect(isTeammateRelayLine(rawLine([{ type: 'text', text: relayString }]))).toBe(true);
    // two wrappers with nothing else are still one relay line
    expect(
      isTeammateRelayLine(rawLine(`${relayString}\n<teammate-message teammate_id="b">hi</teammate-message>`))
    ).toBe(true);
  });

  it('mixed content is a user message, not a relay (issue #59)', () => {
    // the issue repro: a prompt starting with a relay wrapper plus a question
    const mixedString = `${relayString}\nWhy is this tag in the log?`;
    expect(isTeammateRelayLine(rawLine(mixedString))).toBe(false);
    expect(isUserChunkLine(rawLine(mixedString))).toBe(true);
    // turn semantics unchanged: one transcript turn either way
    expect(isTranscriptTurnLine(rawLine(mixedString))).toBe(true);
    // array form: a relay block next to a real question keeps the line user
    const mixedArray = [
      { type: 'text', text: relayString },
      { type: 'text', text: 'go' },
    ];
    expect(isTeammateRelayLine(rawLine(mixedArray))).toBe(false);
    expect(isUserChunkLine(rawLine(mixedArray))).toBe(true);
    expect(isTranscriptTurnLine(rawLine(mixedArray))).toBe(true);
    // a wrapper the strict parser cannot render (unclosed, old-style id='x')
    // is preserved as user text, not swallowed as an invisible relay
    expect(isTeammateRelayLine(rawLine('<teammate-message teammate_id="a">hi'))).toBe(false);
    expect(isTeammateRelayLine(rawLine("<teammate-message id='x'>yo</teammate-message>"))).toBe(
      false
    );
  });

  it('meta lines, non-user lines and plain text are not relays', () => {
    expect(isTeammateRelayLine(rawLine(relayString, true))).toBe(false);
    expect(isTeammateRelayLine({ type: 'assistant', message: { content: relayString } })).toBe(
      false
    );
    expect(isTeammateRelayLine(rawLine('go'))).toBe(false);
    expect(
      isTeammateRelayLine(rawLine([{ type: 'text', text: '[Request interrupted by user]' }]))
    ).toBe(false);
    expect(isTeammateRelayLine(rawLine('<system-reminder>busy</system-reminder>'))).toBe(false);
  });

  it('transcript turns = user turns + relays; the hook canon is unchanged', () => {
    expect(isTranscriptTurnLine(rawLine('go'))).toBe(true);
    expect(isTranscriptTurnLine(rawLine(relayString))).toBe(true);
    expect(isTranscriptTurnLine(flatLine(relayString))).toBe(true);
    // hook canon pinned: a relay is NOT a hook turn boundary
    expect(isUserChunkLine(rawLine(relayString))).toBe(false);
    // non-inputs stay non-turns on both predicates
    expect(isTranscriptTurnLine(rawLine('<local-command-stdout>ok</local-command-stdout>'))).toBe(
      false
    );
    expect(isTranscriptTurnLine({ type: 'assistant', message: { content: 'hi' } })).toBe(false);
    expect(isTranscriptTurnLine(rawLine('', true))).toBe(false);
  });
});
