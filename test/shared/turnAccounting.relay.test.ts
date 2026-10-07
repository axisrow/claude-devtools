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
    // the fixture shape without teammate_id (old-style wrapper) is still a relay
    expect(isTeammateRelayLine(rawLine("<teammate-message id='x'>yo</teammate-message>"))).toBe(
      true
    );
    // relay block next to a real question — the line is a relay (symmetric with
    // the isUserChunkLine exclusion: any relay block makes the line a relay)
    expect(
      isTeammateRelayLine(
        rawLine([
          { type: 'text', text: relayString },
          { type: 'text', text: 'go' },
        ])
      )
    ).toBe(true);
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
