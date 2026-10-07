import { describe, expect, it } from 'vitest';

import {
  incrementalUpdateConversation,
  transformChunksToConversation,
} from '@renderer/utils/groupTransformer';

// =============================================================================
// Test Fixtures (chunk shapes per src/main/types/chunks.ts type guards)
// =============================================================================

function makeMetrics(overrides = {}) {
  return {
    durationMs: 60000,
    totalTokens: 5000,
    inputTokens: 3000,
    outputTokens: 2000,
    cacheReadTokens: 500,
    cacheCreationTokens: 100,
    messageCount: 10,
    costUsd: 0.05,
    ...overrides,
  };
}

let seq = 0;

function makeUserChunk(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `chunk-user-${seq}`,
    chunkType: 'user' as const,
    startTime: new Date('2025-01-15T10:00:00Z'),
    endTime: new Date('2025-01-15T10:00:01Z'),
    durationMs: 1000,
    metrics: makeMetrics({ messageCount: 1 }),
    userMessage: {
      uuid: `user-${seq}`,
      parentUuid: null,
      type: 'user' as const,
      timestamp: new Date('2025-01-15T10:00:00Z'),
      content: `user message ${seq}`,
      isMeta: false,
      isSidechain: false,
    },
    rawMessages: [],
    ...overrides,
  };
}

function makeAIChunk(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `chunk-ai-${seq}`,
    chunkType: 'ai' as const,
    startTime: new Date('2025-01-15T10:00:01Z'),
    endTime: new Date('2025-01-15T10:00:05Z'),
    durationMs: 4000,
    metrics: makeMetrics({ messageCount: 2 }),
    responses: [
      {
        uuid: `assistant-${seq}`,
        parentUuid: null,
        type: 'assistant' as const,
        timestamp: new Date('2025-01-15T10:00:01Z'),
        content: [{ type: 'text', text: 'answer' }],
        isMeta: false,
        isSidechain: false,
      },
    ],
    processes: [],
    sidechainMessages: [],
    toolExecutions: [],
    semanticSteps: [],
    rawMessages: [],
    ...overrides,
  };
}

function makeSystemChunk(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `chunk-system-${seq}`,
    chunkType: 'system' as const,
    startTime: new Date('2025-01-15T10:00:06Z'),
    endTime: new Date('2025-01-15T10:00:07Z'),
    durationMs: 1000,
    metrics: makeMetrics({ messageCount: 1 }),
    message: {
      uuid: `system-${seq}`,
      type: 'user' as const,
      timestamp: new Date('2025-01-15T10:00:06Z'),
      content: 'command output',
      isMeta: true,
      isSidechain: false,
    },
    commandOutput: 'Set model to sonnet',
    rawMessages: [],
    ...overrides,
  };
}

function makeCompactChunk(overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `chunk-compact-${seq}`,
    chunkType: 'compact' as const,
    startTime: new Date('2025-01-15T10:01:00Z'),
    endTime: new Date('2025-01-15T10:01:00Z'),
    durationMs: 0,
    metrics: makeMetrics({ messageCount: 0 }),
    message: {
      uuid: `compact-${seq}`,
      type: 'summary' as const,
      timestamp: new Date('2025-01-15T10:01:00Z'),
      content: 'Summary',
      isMeta: false,
      isSidechain: false,
    },
    rawMessages: [],
    ...overrides,
  };
}

/** AI group turnIndexes in item order. */
function aiTurnIndexes(chunks: Parameters<typeof transformChunksToConversation>[0]) {
  const conv = transformChunksToConversation(chunks, [], false);
  return conv.items
    .filter((item) => item.type === 'ai')
    .map((item) => (item.group as { turnIndex: number }).turnIndex);
}

// =============================================================================
// Turn numbering — must match transcript user-message ordinals 1:1
// =============================================================================

describe('groupTransformer turn numbering', () => {
  it('numbers AI groups by the user message they answer (empty turns consume a number)', () => {
    // [U1, A1, U2 (no response), U3, A3] → Turn 1, Turn 3
    expect(
      aiTurnIndexes([
        makeUserChunk(),
        makeAIChunk(),
        makeUserChunk(),
        makeUserChunk(),
        makeAIChunk(),
      ])
    ).toEqual([0, 2]);
  });

  it('numbers an AI group by its own user message even when the previous turn was empty', () => {
    // [U1, A1, U2 (no response), A2] → A2 answers U2 → Turn 2
    expect(aiTurnIndexes([makeUserChunk(), makeAIChunk(), makeUserChunk(), makeAIChunk()])).toEqual(
      [0, 1]
    );
  });

  it('does not consume a turn number for compact boundaries', () => {
    const chunks = [makeUserChunk(), makeAIChunk(), makeCompactChunk(), makeAIChunk()];
    expect(aiTurnIndexes(chunks)).toEqual([0, 0]);
  });

  it('does not consume a turn number for system chunks', () => {
    const chunks = [makeUserChunk(), makeAIChunk(), makeSystemChunk(), makeAIChunk()];
    expect(aiTurnIndexes(chunks)).toEqual([0, 0]);
  });

  it('falls back to AI-sequence numbering before the first user chunk', () => {
    const chunks = [makeAIChunk(), makeAIChunk(), makeUserChunk(), makeAIChunk()];
    expect(aiTurnIndexes(chunks)).toEqual([0, 1, 0]);
  });

  it('incremental path agrees with the full transform', () => {
    const base = [makeUserChunk(), makeAIChunk()];
    const prev = transformChunksToConversation(base, [], false);
    const grown = incrementalUpdateConversation(
      prev,
      [...base, makeUserChunk(), makeAIChunk()],
      [],
      false
    );
    const aiItems = grown.items.filter((item) => item.type === 'ai');
    expect(aiItems.map((item) => (item.group as { turnIndex: number }).turnIndex)).toEqual([0, 1]);
  });

  it('incremental path accounts for empty turns added in bulk', () => {
    const base = [makeUserChunk(), makeAIChunk(), makeUserChunk(), makeUserChunk()];
    const prev = transformChunksToConversation(base, [], false);
    const grown = incrementalUpdateConversation(prev, [...base, makeAIChunk()], [], false);
    const aiItems = grown.items.filter((item) => item.type === 'ai');
    expect(aiItems.map((item) => (item.group as { turnIndex: number }).turnIndex)).toEqual([0, 2]);
  });

  // ---------------------------------------------------------------------------
  // Teammate relays open transcript turns (issue #55)
  // ---------------------------------------------------------------------------

  /** Flattened user-ParsedMessage carrying a relay wrapper (AI-chunk form). */
  function makeRelayParsed(id: string) {
    return {
      uuid: `relay-${id}`,
      parentUuid: null,
      type: 'user' as const,
      timestamp: new Date('2025-01-15T10:00:00Z'),
      content: `<teammate-message teammate_id="${id}">do it</teammate-message>`,
      isMeta: false,
      isSidechain: false,
    };
  }

  /** Flattened assistant-ParsedMessage answer (AI-chunk responses partner). */
  function makeAssistantParsed(id: string) {
    return {
      uuid: `assistant-${id}`,
      parentUuid: null,
      type: 'assistant' as const,
      timestamp: new Date('2025-01-15T10:00:01Z'),
      content: [{ type: 'text', text: 'answer' }],
      isMeta: false,
      isSidechain: false,
    };
  }

  it('numbers a teammates-only session starting at Turn 1', () => {
    // [AI(relay, assistant)] → Turn 1 (was aiCount-fallback territory pre-#55)
    expect(
      aiTurnIndexes([makeAIChunk({ responses: [makeRelayParsed('1'), makeAssistantParsed('1')] })])
    ).toEqual([0]);
  });

  it('numbers a giant AI chunk holding several relays by its last opened turn', () => {
    // [AI(r1, a1, r2, a2)] — one group, two relays → last opened turn = Turn 2
    const chunk = makeAIChunk({
      responses: [
        makeRelayParsed('1'),
        makeAssistantParsed('1'),
        makeRelayParsed('2'),
        makeAssistantParsed('2'),
      ],
    });
    expect(aiTurnIndexes([chunk])).toEqual([1]);
  });

  it('a relay after user turns shifts the numbering', () => {
    // [U, A, AI(relay, a2)] → U1 opens Turn 1, the relay opens Turn 2
    expect(
      aiTurnIndexes([
        makeUserChunk(),
        makeAIChunk(),
        makeAIChunk({ responses: [makeRelayParsed('2'), makeAssistantParsed('2')] }),
      ])
    ).toEqual([0, 1]);
  });

  it('a relay with no answer still consumes a turn number', () => {
    // [AI(relay), U, AI(a)] → relay = Turn 1, U = Turn 2 → [0, 1]
    expect(
      aiTurnIndexes([
        makeAIChunk({ responses: [makeRelayParsed('1')] }),
        makeUserChunk(),
        makeAIChunk(),
      ])
    ).toEqual([0, 1]);
  });

  it('incremental path recounts relays from reused AI groups', () => {
    // base [AI(r1,a1), U] grows with [AI(r2,a2)] → [0, 2]: the reused relay
    // must be re-counted or the new group would get Turn 2 instead of Turn 3
    const base = [
      makeAIChunk({ responses: [makeRelayParsed('1'), makeAssistantParsed('1')] }),
      makeUserChunk(),
    ];
    const prev = transformChunksToConversation(base, [], false);
    const grown = incrementalUpdateConversation(
      prev,
      [...base, makeAIChunk({ responses: [makeRelayParsed('2'), makeAssistantParsed('2')] })],
      [],
      false
    );
    const aiItems = grown.items.filter((item) => item.type === 'ai');
    expect(aiItems.map((item) => (item.group as { turnIndex: number }).turnIndex)).toEqual([0, 2]);
  });

  it('incremental path numbers a relay appended after user turns', () => {
    const base = [makeUserChunk(), makeAIChunk()];
    const prev = transformChunksToConversation(base, [], false);
    const grown = incrementalUpdateConversation(
      prev,
      [...base, makeAIChunk({ responses: [makeRelayParsed('2'), makeAssistantParsed('2')] })],
      [],
      false
    );
    const aiItems = grown.items.filter((item) => item.type === 'ai');
    expect(aiItems.map((item) => (item.group as { turnIndex: number }).turnIndex)).toEqual([0, 1]);
  });
});
